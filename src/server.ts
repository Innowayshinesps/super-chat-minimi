import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handleTurn, type TurnDeps, type TurnEvent } from './chat.ts';
import { makeClock, formatInZone } from './clock.ts';
import { agentKeys, config, requireKeys, ROOT } from './config.ts';
import { Store } from './db.ts';
import { createAgentLLM } from './models.ts';
import { DEMO_NOW, seedDemo } from './seed.ts';
import { tavilyClient } from './search.ts';

const WEB = path.join(ROOT, 'web');
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: path.join(WEB, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: path.join(WEB, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: path.join(WEB, 'style.css'), type: 'text/css; charset=utf-8' },
  '/vendor/marked.js': {
    file: path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.esm.js'),
    type: 'text/javascript; charset=utf-8',
  },
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 100_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Message too large.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  requireKeys(agentKeys());
  // --demo: its own database, seeded with two older chats, and a clock set to match them
  const demo = process.argv.includes('--demo');
  const nowOverride = demo ? DEMO_NOW : config.nowOverride;
  const clock = makeClock({ nowOverride, tz: config.tz });
  const store = new Store(demo ? path.join(ROOT, 'data', 'demo.db') : config.dbPath);
  if (demo && store.messageCount() === 0) seedDemo(store, config.tz);
  const tavily = tavilyClient(config.tavilyKey);
  const llm = createAgentLLM();
  await llm.verify();

  const deps: TurnDeps = { store, clock, llm, tavily, tokenBudget: config.contextTokens };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const p = url.pathname;

      if (req.method === 'GET' && STATIC[p]) {
        const s = STATIC[p];
        const body = await readFile(s.file);
        res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && p === '/api/info') {
        const now = clock.now();
        return json(res, 200, {
          model: config.agentModel,
          provider: config.agentProvider,
          tz: clock.tz,
          now: now.toISOString(),
          nowLabel: formatInZone(now, clock.tz),
          simulated: Boolean(nowOverride),
        });
      }

      if (req.method === 'GET' && p === '/api/chats') {
        return json(res, 200, { chats: store.listChats() });
      }

      const m = /^\/api\/chats\/([\w-]+)$/.exec(p);
      if (req.method === 'GET' && m) {
        const chat = store.getChat(m[1]);
        if (!chat) return json(res, 404, { error: 'No such chat.' });
        const messages = store.chatMessages(chat.id).map((msg) => {
          const runs = msg.role === 'assistant' ? store.runsFor(msg.id) : [];
          return {
            ...msg,
            searches: runs.map((r) => ({
              query: r.query,
              sources: r.evidence.map((e) => ({ title: e.title, url: e.url, published_date: e.published_date })),
            })),
          };
        });
        return json(res, 200, { chat, messages });
      }

      if (req.method === 'POST' && p === '/api/chat') {
        let body: { chatId?: string; message?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : 'Bad request.' });
        }
        if (!body.message || !String(body.message).trim()) return json(res, 400, { error: 'Say something first.' });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const ac = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) ac.abort(new Error('client went away'));
        });
        const send = (e: TurnEvent) => {
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        try {
          await handleTurn(deps, { chatId: body.chatId, text: String(body.message), signal: ac.signal }, send);
        } catch (err) {
          if (!ac.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[turn failed]', message);
            send({ type: 'error', message: friendly(message) });
          }
        }
        res.end();
        return;
      }

      json(res, 404, { error: 'Not found.' });
    } catch (err) {
      console.error('[request failed]', err);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the server.' });
      else res.end();
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Set PORT in .env to another number.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(config.port, () => {
    console.log(`\n  minimi chat agent  →  http://localhost:${config.port}`);
    console.log(`  model: ${config.agentModel} on ${config.agentProvider} (reasoning: ${config.agentEffort})`);
    console.log(
      `  clock: ${formatInZone(clock.now(), clock.tz)} ${clock.tz}${nowOverride ? '  [simulated clock]' : ''}\n`,
    );
  });
}

function friendly(message: string): string {
  if (/quota is used up/i.test(message)) return message; // already written for the user
  if (/request too large|413/i.test(message)) return 'That request is larger than the model tier allows per minute. Try a shorter question, or use a tier with higher limits.';
  if (/high demand|UNAVAILABLE|503|over capacity/i.test(message)) return 'The model is busy right now. Please try again in a moment.';
  if (/429|RESOURCE_EXHAUSTED/i.test(message)) return 'The model rate limit was hit. Wait a few seconds and try again.';
  if (/no first token/i.test(message)) return 'The model took too long to respond. Please try again.';
  return message.length > 300 ? message.slice(0, 300) + '…' : message;
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

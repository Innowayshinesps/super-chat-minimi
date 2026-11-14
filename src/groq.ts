import {
  FIRST_TOKEN_TIMEOUT_MS,
  isDailyLimit,
  isTransientStatus,
  type LLM,
  MAX_ATTEMPTS,
  MAX_WAIT_S,
  type Msg,
  normalize,
  QuotaError,
  quotaMessage,
  retryAfterSeconds,
  sleep,
  type StepResult,
  type ToolCall,
  type ToolSpec,
} from './llm.ts';

/** Groq adapter (OpenAI-compatible chat completions). The only place that knows that format. */

const URL = 'https://api.groq.com/openai/v1/chat/completions';

type OpenAIMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAI(system: string, messages: Msg[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }];
  for (const m of normalize(messages)) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.calls?.length
          ? { tool_calls: m.calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.response) });
    }
  }
  return out;
}

export function groqLLM(opts: {
  apiKey: string;
  model: string;
  tools: ToolSpec[];
  effort: string;
  /** With a backup model: a per-minute wait longer than this many seconds hands the turn to the backup instead of waiting. */
  switchAfterS?: number;
}): LLM & { verify(): Promise<void> } {
  if (!['low', 'medium', 'high'].includes(opts.effort)) {
    throw new Error(`AGENT_EFFORT for Groq must be low, medium or high (got "${opts.effort}")`);
  }
  const tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  return {
    async verify() {
      const r = await fetch('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 401 || r.status === 403) throw new Error(`Groq rejected the API key (HTTP ${r.status}). Check GROQ_API_KEY in .env.`);
      if (!r.ok) return; // not a reason to refuse to start
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map((m) => m.id);
      if (ids.length && !ids.includes(opts.model)) {
        const chat = ids.filter((id) => !/whisper|orpheus|guard|tts/i.test(id));
        throw new Error(`Your Groq key cannot see the model "${opts.model}". Set AGENT_MODEL in .env to one it can. Available: ${chat.join(', ')}`);
      }
    },

    async step(req, onText) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
        const ac = new AbortController();
        const onOuter = () => ac.abort(req.signal?.reason);
        req.signal?.addEventListener('abort', onOuter, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort(new Error('no first token'));
        }, FIRST_TOKEN_TIMEOUT_MS);

        let text = '';
        const acc = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: string | undefined;
        let usage: StepResult['usage'];
        let status: number | undefined;

        try {
          const r = await fetch(URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
            signal: ac.signal,
            body: JSON.stringify({
              model: opts.model,
              stream: true,
              stream_options: { include_usage: true },
              messages: toOpenAI(req.allowTools ? req.system : `${req.system}

You have searched enough. Answer now with what you have, and say plainly what you could not verify.`, req.messages),
              // on the last step the tools are simply not offered, so the model has to answer
              ...(req.allowTools ? { tools, tool_choice: 'auto' } : {}),
              reasoning_effort: opts.effort,
              include_reasoning: false,
              temperature: 0.3,
            }),
          });
          status = r.status;
          if (!r.ok || !r.body) {
            const body = await r.text();
            const err = new Error(`Groq ${r.status}: ${body.slice(0, 600)}`) as Error & { status?: number; retryAfter?: number };
            err.status = r.status;
            const h = Number(r.headers.get('retry-after'));
            if (Number.isFinite(h) && h > 0) err.retryAfter = h;
            throw err;
          }
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let first = true;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const ev = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
              if (!data || data === '[DONE]') continue;
              let j: any;
              try {
                j = JSON.parse(data);
              } catch {
                continue;
              }
              if (j.error) throw Object.assign(new Error(`Groq stream error: ${JSON.stringify(j.error).slice(0, 400)}`), { status: j.error.code });
              if (first) {
                first = false;
                clearTimeout(timer);
              }
              const usageObj = j.usage ?? j.x_groq?.usage;
              if (usageObj) usage = { promptTokens: usageObj.prompt_tokens, outputTokens: usageObj.completion_tokens };
              const choice = j.choices?.[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const d = choice.delta ?? {};
              if (d.content) {
                text += d.content;
                onText(d.content);
              }
              for (const tc of d.tool_calls ?? []) {
                const cur = acc.get(tc.index ?? 0) ?? { id: '', name: '', args: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name += tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                acc.set(tc.index ?? 0, cur);
              }
            }
          }
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onOuter);
          const calls: ToolCall[] = [...acc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([i, c]) => {
              let args: Record<string, unknown> = {};
              try {
                args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
              } catch {
                /* malformed arguments: the tool replies that no queries were given, and the model retries */
              }
              return { id: c.id || `call_${i}`, name: c.name, args };
            });
          return { text, calls, finishReason, usage };
        } catch (err) {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onOuter);
          if (req.signal?.aborted) throw err;
          lastErr = err;
          const raw = String((err as Error)?.message ?? '');
          const nothingSent = text === '' && acc.size === 0;
          const st = (err as { status?: number }).status ?? status;
          // one request bigger than the per-minute cap can never succeed here; let the backup model take the turn
          if (st === 413 && nothingSent) throw new QuotaError(quotaMessage(`Groq (${opts.model})`, raw), 'size');
          if (st === 429) {
            const wait = (err as { retryAfter?: number }).retryAfter ?? retryAfterSeconds(raw);
            if (isDailyLimit(raw) || wait === undefined || wait > MAX_WAIT_S || attempt === MAX_ATTEMPTS - 1) {
              throw new QuotaError(quotaMessage(`Groq (${opts.model})`, raw));
            }
            if (opts.switchAfterS !== undefined && !req.patient && nothingSent && wait > opts.switchAfterS) throw new QuotaError(quotaMessage(`Groq (${opts.model})`, raw), 'rate');
            req.onWait?.(Math.ceil(wait), 'rate limit');
            await sleep(wait * 1000 + 250);
            continue;
          }
          const retryable = (timedOut || isTransientStatus(st, raw)) && nothingSent;
          if (!retryable || attempt === MAX_ATTEMPTS - 1) throw err;
          await sleep(600 * 2 ** attempt + Math.random() * 300);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

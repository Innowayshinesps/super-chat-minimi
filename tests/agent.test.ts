import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.ts';
import { handleTurn, type TurnEvent } from '../src/chat.ts';
import { frozenClock } from '../src/clock.ts';
import { toContents } from '../src/gemini.ts';
import { toOpenAI } from '../src/groq.ts';
import type { Msg } from '../src/llm.ts';
import { Store } from '../src/db.ts';
import { relevantExcerpt, webSearch } from '../src/search.ts';
import { seedDemo } from '../src/seed.ts';
import { FakeTavily, ScriptedLLM, callSearch, callSearches, say } from './helpers.ts';

const TZ = 'Asia/Kolkata';
const clock = frozenClock('2026-11-13T10:00:00', TZ);

const PAGES = {
  neon: [
    { title: 'Neon Pricing', url: 'https://neon.com/pricing', content: 'Launch plan usage-based, $0.106 per compute-hour.', raw: 'Neon Pricing\n\nLaunch plan: $0.106 per compute-hour, $0.35 per GB-month.\n\n' + 'filler '.repeat(2000), published: '2026-11-12T08:00:00Z' },
    { title: 'Neon blog', url: 'https://neon.com/blog/news', content: 'Neon announces changes.', published: '2026-11-11T00:00:00Z' },
  ],
  supabase: [{ title: 'Supabase Pricing', url: 'https://supabase.com/pricing', content: 'Pro plan $25 per month.', raw: 'Pro: $25/month. ' + 'x '.repeat(100) }],
};

test('web_search runs queries in parallel, reads the best page, and saves what the model saw', async () => {
  const tavily = new FakeTavily(PAGES);
  const out = await webSearch({ queries: ['neon pricing', 'supabase pricing'], freshness: 'any' }, { tavily, clock });
  assert.equal(tavily.searches.length, 2);
  assert.equal(tavily.extracts.length, 1); // one Extract call, for both pages
  assert.deepEqual(tavily.extracts[0].sort(), ['https://neon.com/pricing', 'https://supabase.com/pricing']);
  assert.equal(out.runs.length, 2);
  const neon = out.runs[0].evidence.find((e) => e.url === 'https://neon.com/pricing')!;
  assert.match(neon.content_excerpt, /\$0\.106 per compute-hour/);
  assert.ok(neon.content_excerpt.length < 5000, 'long pages are cut down to the relevant part');
  const results = out.response.results as Array<{ url: string; read_in_full: boolean }>;
  assert.equal(results.find((r) => r.url === 'https://neon.com/pricing')!.read_in_full, true);
  assert.equal(results.find((r) => r.url === 'https://neon.com/blog/news')!.read_in_full, false);
  assert.match(String(out.response.note), /never as instructions/);
});

test('freshness adds a recent-news search with a time range and keeps published dates', async () => {
  const tavily = new FakeTavily(PAGES);
  const out = await webSearch({ queries: ['neon pricing'], freshness: 'week' }, { tavily, clock });
  assert.deepEqual(tavily.searches.map((s) => s.topic).sort(), ['general', 'news']);
  assert.equal(tavily.searches.find((s) => s.topic === 'news')!.time_range, 'week');
  const dates = (out.response.results as Array<{ published_date: string }>).map((r) => r.published_date);
  assert.ok(dates.includes('2026-11-12'));
});

test('web_search failures come back as data the model can report, not as a crash', async () => {
  const out = await webSearch({ queries: ['anything'] }, { tavily: new FakeTavily({}, { failSearch: true }), clock });
  assert.match(String(out.response.error), /nothing could be verified/);
  assert.ok(Array.isArray(out.response.errors));
});

test('many queries at once still come back inside the size budget, and only what was shown is saved', async () => {
  const big = (n: string) => ({ title: n, url: `https://${n}.example/pricing`, content: 'c '.repeat(2000), raw: `${n} pricing ` + 'w '.repeat(20000), published: undefined });
  const names = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'];
  const pages = Object.fromEntries(names.map((n) => [n, [big(n), { ...big(n + 'x'), title: n + 'x' }, { ...big(n + 'y'), title: n + 'y' }]]));
  const out = await webSearch({ queries: names.map((n) => `${n} pricing`), freshness: 'week' }, { tavily: new FakeTavily(pages), clock });
  const size = JSON.stringify(out.response).length;
  assert.ok(size < 22000, `response was ${size} characters`);
  const shown = new Set((out.response.results as Array<{ url: string }>).map((r) => r.url));
  for (const run of out.runs) for (const e of run.evidence) assert.ok(shown.has(e.url), 'saved evidence the model never saw');
});

test('relevantExcerpt keeps the parts of a long page that hold the numbers', () => {
  const page = Array.from({ length: 60 }, (_, i) => (i === 40 ? 'Pro plan costs $25 per month.' : `Paragraph ${i} about unrelated things.`)).join('\n\n');
  const ex = relevantExcerpt(page, ['pro', 'plan'], 600);
  assert.match(ex, /\$25 per month/);
  assert.ok(ex.length < 1100);
});

test('agent loop: one search round, then an answer; calls and sources are recorded', async () => {
  const llm = new ScriptedLLM([callSearch(['neon pricing', 'supabase pricing'], 'week'), say('Neon is $0.106/hour [Neon](https://neon.com/pricing).')]);
  const events: string[] = [];
  const res = await runAgent({
    llm, tavily: new FakeTavily(PAGES), clock, system: 'sys', history: [], userText: 'prices?',
    emit: (e) => events.push(e.type),
  });
  assert.match(res.answer, /0\.106/);
  assert.equal(res.steps, 2);
  assert.equal(res.runs.length, 2);
  assert.deepEqual(events.filter((e) => e !== 'delta'), ['search', 'sources']);
  // the tool result went back to the model, tied to the call's id
  const second = llm.requests[1].messages;
  const last = second[second.length - 1];
  assert.equal(last.role, 'tool');
  assert.equal((last as Extract<Msg, { role: 'tool' }>).results[0].id, 'call_1');
  assert.equal(llm.requests[0].allowTools, true);
});

test('parallel tool calls in one step all run and all get a response', async () => {
  const llm = new ScriptedLLM([callSearches([['neon pricing'], ['supabase pricing']]), say('done')]);
  const tavily = new FakeTavily(PAGES);
  const res = await runAgent({ llm, tavily, clock, system: 's', history: [], userText: 'q', emit: () => {} });
  assert.equal(res.runs.length, 2);
  const last = llm.requests[1].messages.at(-1) as Extract<Msg, { role: 'tool' }>;
  assert.equal(last.results.length, 2);
  assert.deepEqual(last.results.map((r) => r.id), ['call_0', 'call_1']);
});

test('an agent that keeps searching is cut off: the last step forbids tools and must answer', async () => {
  const llm = new ScriptedLLM([callSearch(['a']), callSearch(['b']), callSearch(['c']), say('final answer')]);
  const res = await runAgent({ llm, tavily: new FakeTavily(PAGES), clock, system: 's', history: [], userText: 'q', emit: () => {} });
  assert.equal(llm.requests.length, 4);
  assert.deepEqual(llm.requests.map((r) => r.allowTools), [true, true, true, false]);
  assert.equal(res.answer, 'final answer');
});

test('a made-up tool name gets an error response instead of a crash', async () => {
  const bad = { calls: [{ id: 'x', name: 'run_shell', args: {} }], text: '' };
  const llm = new ScriptedLLM([bad, say('ok')]);
  const res = await runAgent({ llm, tavily: new FakeTavily(), clock, system: 's', history: [], userText: 'q', emit: () => {} });
  assert.equal(res.answer, 'ok');
  const last = llm.requests[1].messages.at(-1) as Extract<Msg, { role: 'tool' }>;
  assert.match(String(last.results[0].response.error), /Only web_search exists/);
});

test('Gemini adapter: turns alternate, start with the user, and replay reasoning signatures untouched', () => {
  const raw = [{ functionCall: { id: 'c1', name: 'web_search', args: { queries: ['x'] } }, thoughtSignature: 'SIG' }];
  const c = toContents([
    { role: 'assistant', text: 'stray' },
    { role: 'user', text: 'a' },
    { role: 'user', text: 'b' },
    { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'web_search', args: { queries: ['x'] } }], raw },
    { role: 'tool', results: [{ id: 'c1', name: 'web_search', response: { ok: true } }] },
  ]);
  assert.deepEqual(c.map((x) => x.role), ['user', 'model', 'user']);
  assert.match((c[0].parts![0] as any).text, /a\n\nb/);
  assert.equal((c[1].parts![0] as any).thoughtSignature, 'SIG');
  assert.equal((c[2].parts![0] as any).functionResponse.id, 'c1');
});

test('Groq adapter: system prompt first, tool calls as JSON, one tool message per result', () => {
  const m = toOpenAI('SYS', [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'web_search', args: { queries: ['x', 'y'] } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'web_search', response: { a: 1 } }, { id: 'c2', name: 'web_search', response: { b: 2 } }] },
  ]);
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'tool']);
  const asst = m[2] as any;
  assert.equal(asst.content, null);
  assert.equal(asst.tool_calls[0].function.arguments, JSON.stringify({ queries: ['x', 'y'] }));
  assert.equal((m[3] as any).tool_call_id, 'c1');
  assert.equal((m[4] as any).content, JSON.stringify({ b: 2 }));
});

test('a full turn is saved with its searches and evidence, and the next turn can recall it', async () => {
  const store = new Store(':memory:');
  const tavily = new FakeTavily(PAGES);
  const llm1 = new ScriptedLLM([callSearch(['neon pricing']), say('Neon Launch is usage-based [Neon](https://neon.com/pricing).')]);
  const events: TurnEvent[] = [];
  const first = await handleTurn({ store, clock, llm: llm1, tavily, tokenBudget: 24000 }, { text: 'How much is Neon?' }, (e) => events.push(e));
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(store.chatMessages(first.chatId).length, 2);
  assert.equal(store.runsFor(first.assistantId!).length, 1);
  assert.ok(first.ttftMs !== null);

  const llm2 = new ScriptedLLM([say('You asked how much Neon is.')]);
  const second = await handleTurn({ store, clock, llm: llm2, tavily, tokenBudget: 24000 }, { chatId: undefined, text: 'What did I ask you earlier today?' }, () => {});
  assert.notEqual(second.chatId, first.chatId);
  assert.equal(second.debug.exactTurns.length, 1);
  assert.match(llm2.requests[0].system, /How much is Neon\?/);
  assert.match(llm2.requests[0].system, /neon\.com\/pricing/);
});

test('a failed turn is not saved, so memory never holds half a turn', async () => {
  const store = new Store(':memory:');
  const llm = { step: async () => { throw new Error('boom'); } };
  await assert.rejects(handleTurn({ store, clock, llm, tavily: new FakeTavily(), tokenBudget: 24000 }, { text: 'hello' }, () => {}), /boom/);
  assert.equal(store.messageCount(), 0);
});

test('the challenge example: "last Tuesday... Postgres hosting... pricing changed?" reaches the model with the old baseline', async () => {
  const store = new Store(':memory:');
  seedDemo(store, TZ);
  const llm = new ScriptedLLM([callSearch(['Supabase pricing', 'Neon pricing', 'Railway pricing'], 'month'), say('No change found for Supabase.')]);
  const out = await handleTurn(
    { store, clock, llm, tavily: new FakeTavily(PAGES), tokenBudget: 24000 },
    { text: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?' },
    () => {},
  );
  const sys = llm.requests[0].system;
  for (const host of ['Supabase', 'Neon', 'Railway']) assert.match(sys, new RegExp(host));
  assert.match(sys, /\$25\/month/);
  assert.match(sys, /3 November 2026/);
  assert.equal(out.debug.dateRefs[0].usedAlt, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenClock } from '../src/clock.ts';
import { buildContext } from '../src/context.ts';
import { Store } from '../src/db.ts';
import { seedDemo } from '../src/seed.ts';

const TZ = 'Asia/Kolkata';
const clock = frozenClock('2026-11-13T10:00:00', TZ);
const budget = { tokenBudget: 24000 };

function demoStore() {
  const s = new Store(':memory:');
  seedDemo(s, TZ);
  return s;
}

test('the store keeps a turn as one bundle: question, searches, evidence, answer', () => {
  const s = demoStore();
  const answer = s.searchMessages(['Neon'], 5).find((m) => m.role === 'assistant')!;
  const b = s.bundleFor(answer);
  assert.match(b.question!.content, /Postgres host/);
  assert.equal(b.runs.length, 3);
  assert.ok(b.runs.every((r) => r.evidence.length === 1));
  assert.equal(b.runs[0].evidence[0].url, 'https://supabase.com/pricing');
});

test('full-text search finds messages by product name', () => {
  const s = demoStore();
  const hits = s.searchMessages(['Pipedrive']);
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((m) => /Pipedrive/i.test(m.content)));
});

test('"on 3 November" recalls that day with its saved sources', () => {
  const s = demoStore();
  const c = buildContext(s, clock, 'new-chat', 'What did I ask you on 3 November? Is your answer still correct today?', budget);
  assert.equal(c.debug.exactTurns.length, 1);
  assert.match(c.debug.exactTurns[0].question, /Postgres host/);
  assert.equal(c.debug.exactTurns[0].withEvidence, true);
  assert.match(c.system, /supabase\.com\/pricing/);
  assert.match(c.system, /\$25\/month/);
  assert.match(c.system, /ISO date 2026-11-13/);
});

test('"last Tuesday" with nothing on the 10th falls back to the 3rd and says so', () => {
  const s = demoStore();
  const c = buildContext(s, clock, 'new-chat', 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', budget);
  assert.equal(c.debug.dateRefs[0].usedAlt, true);
  assert.equal(c.debug.exactTurns.length, 1);
  assert.ok(c.debug.notes.some((n) => /last Tuesday.*3 November/i.test(n)));
});

test('"On Monday we shortlisted 5 CRM tools" recalls the whole shortlist and its sources', () => {
  const s = demoStore();
  const c = buildContext(s, clock, 'new-chat', 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?', budget);
  assert.equal(c.debug.exactTurns.length, 1);
  for (const name of ['HubSpot', 'Pipedrive', 'Zoho', 'Salesforce', 'Freshsales']) assert.match(c.system, new RegExp(name));
  assert.match(c.system, /pipedrive\.com\/en\/pricing/);
});

test('no record for the date asked: the context says so instead of leaving a gap', () => {
  const s = demoStore();
  const c = buildContext(s, clock, 'new-chat', 'What did I ask you on 5 November?', budget);
  assert.equal(c.debug.exactTurns.length, 0);
  assert.ok(c.debug.notes.some((n) => /No messages are recorded for .*5 November/.test(n)));
  assert.ok(c.debug.notes.some((n) => /earliest recorded message is from .*3 November/i.test(n)));
});

test('empty history: nothing to recall, and the context says nothing is recorded at all', () => {
  const s = new Store(':memory:');
  const c = buildContext(s, clock, 'new-chat', 'What did I ask you on 3 November?', budget);
  assert.ok(c.debug.notes.some((n) => /No messages are recorded at all/.test(n)));
  assert.match(c.system, /Do not invent a conversation/);
});

test('related turns are found by name even with no date in the message', () => {
  const s = demoStore();
  const c = buildContext(s, clock, 'new-chat', 'Is Neon still the cheapest option?', budget);
  assert.ok(c.debug.relatedTurns.length >= 1);
  assert.match(c.debug.relatedTurns[0].question, /Postgres host/);
});

test('this chat is passed verbatim and is not repeated as recalled memory', () => {
  const s = new Store(':memory:');
  const chat = s.createChat('t', clock.now());
  s.saveTurn({ chatId: chat.id, userText: 'hello', assistantText: 'hi there', userAt: clock.now(), assistantAt: clock.now(), searches: [] });
  const c = buildContext(s, clock, chat.id, 'what did I ask you today?', budget);
  assert.deepEqual(c.history.map((h) => h.role), ['user', 'assistant']);
  assert.equal(c.debug.exactTurns.length, 0);
});

test('over budget: the chat index goes first, then evidence, and the exact turn text stays', () => {
  const s = demoStore();
  const tiny = buildContext(s, clock, 'new-chat', 'What did I ask you on 3 November?', { tokenBudget: 2250 });
  assert.equal(tiny.debug.exactTurns.length, 1);
  assert.ok(tiny.debug.trimmed.length > 0);
  assert.match(tiny.system, /\$25\/month/); // the answer text survived
  assert.equal(tiny.debug.indexChats, 0); // the index did not
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackLLM, flattenToolHistory } from '../src/fallback.ts';
import { type LLM, type Msg, QuotaError, type StepRequest } from '../src/llm.ts';
import { ScriptedLLM, callSearch, say } from './helpers.ts';

const names = { primary: 'main', secondary: 'backup' };
const quota: LLM = { step: async () => { throw new QuotaError('used up'); } };
const req = (messages: Msg[], extra: Partial<StepRequest> = {}): StepRequest => ({ system: 's', messages, allowTools: true, ...extra });

test('quota used up on the first step: the turn runs on the backup and the page is told', async () => {
  const backup = new ScriptedLLM([say('from backup')]);
  const llm = new FallbackLLM(quota, backup, names);
  const notices: string[] = [];
  const out = await llm.step(req([{ role: 'user', text: 'q' }], { onNotice: (t) => notices.push(t) }), () => {});
  assert.equal(out.text, 'from backup');
  assert.match(notices[0], /main has used up its daily quota.*backup/);
});

test('a long per-minute wait moves the turn to the backup and the page says why', async () => {
  const slow: LLM = { step: async () => { throw new QuotaError('wait', 'rate'); } };
  const llm = new FallbackLLM(slow, new ScriptedLLM([say('from backup')]), names);
  const notices: string[] = [];
  await llm.step(req([{ role: 'user', text: 'q' }], { onNotice: (t) => notices.push(t) }), () => {});
  assert.match(notices[0], /main is rate limited.*backup/);
});

test('a rate-limit switch to a backup with no quota falls back to waiting on the main model', async () => {
  let patient: boolean | undefined;
  const main: LLM = { step: async (r, t) => { if (!r.patient) throw new QuotaError('wait', 'rate'); patient = r.patient; return new ScriptedLLM([say('from main')]).step(r, t); } };
  const llm = new FallbackLLM(main, quota, names);
  const out = await llm.step(req([{ role: 'user', text: 'q' }]), () => {});
  assert.equal(out.text, 'from main');
  assert.equal(patient, true);
});

test('a later step that runs out of quota moves to the backup, with earlier tool results as plain text', async () => {
  const backup = new ScriptedLLM([say('final')]);
  let calls = 0;
  const flaky: LLM = {
    step: async (r, t) => {
      if (calls++ === 0) return new ScriptedLLM([callSearch(['x'])]).step(r, t);
      throw new QuotaError('used up');
    },
  };
  const llm = new FallbackLLM(flaky, backup, names);
  const messages: Msg[] = [{ role: 'user', text: 'q' }];
  const first = await llm.step(req(messages), () => {});
  messages.push({ role: 'assistant', text: first.text, calls: first.calls, raw: first.raw });
  messages.push({ role: 'tool', results: [{ id: 'call_1', name: 'web_search', response: { results: [{ title: 'Neon' }] } }] });
  const second = await llm.step(req(messages), () => {}); // the main model is out of quota here
  assert.equal(second.text, 'final');
  const sent = backup.requests[0].messages;
  assert.ok(sent.every((m) => m.role !== 'tool' && !(m.role === 'assistant' && m.calls)));
  assert.match(JSON.stringify(sent), /Neon/);
});

test('other errors, and a quota error after text has streamed, are not hidden', async () => {
  const boom: LLM = { step: async () => { throw new Error('boom'); } };
  await assert.rejects(new FallbackLLM(boom, new ScriptedLLM([say('x')]), names).step(req([{ role: 'user', text: 'q' }]), () => {}), /boom/);
  const late: LLM = { step: async (_r, onText) => { onText('partial'); throw new QuotaError('used up'); } };
  await assert.rejects(new FallbackLLM(late, new ScriptedLLM([say('x')]), names).step(req([{ role: 'user', text: 'q' }]), () => {}), /used up/);
});

test('flattening keeps provider-native tool history (it has raw replay data)', () => {
  const kept: Msg = { role: 'assistant', text: '', calls: [{ id: 'a', name: 'web_search', args: {} }], raw: [{ functionCall: {} }] };
  const out = flattenToolHistory([{ role: 'user', text: 'q' }, kept, { role: 'tool', results: [{ id: 'a', name: 'web_search', response: {} }] }]);
  assert.equal(out[1], kept);
});

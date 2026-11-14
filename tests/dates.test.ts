import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frozenClock, isoDay } from '../src/clock.ts';
import { resolveDates } from '../src/dates.ts';

// Friday 13 November 2026, 10:00 in India
const clock = frozenClock('2026-11-13T10:00:00', 'Asia/Kolkata');
const day = (d: Date) => isoDay(d, 'Asia/Kolkata');
const one = (text: string) => {
  const r = resolveDates(text, clock);
  assert.equal(r.length, 1, `expected one date in "${text}", got ${r.map((x) => x.phrase)}`);
  return r[0];
};

test('"On Monday" is the most recent past Monday', () => {
  const r = one('On Monday we shortlisted 5 CRM tools for a 20-person sales team.');
  assert.equal(day(r.start), '2026-11-09');
});

test('"3 November" resolves to that day of this year', () => {
  const r = resolveDates('What did I ask you on 3 November?', clock).find((x) => /November/.test(x.phrase))!;
  assert.equal(day(r.start), '2026-11-03');
  assert.equal(day(new Date(r.end.getTime() - 1)), '2026-11-03');
});

test('"last Tuesday" has a main reading and the week before as the other', () => {
  const r = one('Last Tuesday I asked you about Postgres hosting.');
  assert.equal(day(r.start), '2026-11-10');
  assert.equal(day(r.alt!.start), '2026-11-03');
});

test('yesterday, "3 days ago" and "the past 3 days"', () => {
  assert.equal(day(one('what did we talk about yesterday').start), '2026-11-12');
  assert.equal(day(one('3 days ago I asked about Neon').start), '2026-11-10');
  const r = one('summarise the past 3 days');
  assert.equal(day(r.start), '2026-11-10');
  assert.equal(day(new Date(r.end.getTime() - 1)), '2026-11-13');
});

test('"last week" is the previous Monday to Sunday', () => {
  const r = one('what did I ask last week');
  assert.equal(day(r.start), '2026-11-02');
  assert.equal(day(new Date(r.end.getTime() - 1)), '2026-11-08');
});

test('a date with no year, said before that date, means last year', () => {
  const r = resolveDates('what did I ask you about on 20 December?', clock)[0];
  assert.equal(day(r.start), '2025-12-20');
  // no past cue: it is a coming date, not history
  assert.equal(resolveDates('what\'s my work on 14 November?', clock).length, 0);
});

test('ordinary words and future phrases are not dates in history', () => {
  assert.equal(resolveDates('I sat on the fence in may about it', clock).length, 0);
  assert.equal(resolveDates('what is the best CRM', clock).length, 0);
  assert.equal(resolveDates('next Tuesday we meet', clock).length, 0);
  assert.equal(resolveDates('see you tomorrow', clock).length, 0);
});

test('day boundaries follow the time zone, not UTC', () => {
  // 10:00 IST on the 13th is still the 13th; 00:30 IST on the 14th is 19:00 UTC on the 13th
  const late = frozenClock('2026-11-14T00:30:00', 'Asia/Kolkata');
  const r = resolveDates('what did I ask yesterday', late)[0];
  assert.equal(isoDay(r.start, 'Asia/Kolkata'), '2026-11-13');
  assert.equal(r.start.toISOString(), '2026-11-12T18:30:00.000Z');
});

test('"today" is a history reference only when the question looks back', () => {
  assert.equal(resolveDates('Is your answer still correct today?', clock).length, 0);
  assert.equal(resolveDates('what did we discuss today?', clock).length, 1);
});

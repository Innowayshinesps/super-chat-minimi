import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { handleTurn, type TurnOutcome } from '../src/chat.ts';
import { frozenClock } from '../src/clock.ts';
import { agentKeys, config, requireKeys, ROOT } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { QuotaError } from '../src/llm.ts';
import { createAgentLLM } from '../src/models.ts';
import { DEMO_NOW, seedDemo } from '../src/seed.ts';
import { FakeTavily } from '../tests/helpers.ts';
import { freshWorld } from './fixtures.ts';
import { judge, judgeAvailable, judgeLabel, type Verdict } from './judge.ts';

/**
 * `npm run eval [-- case-id ...] [--no-judge]`
 *
 * End to end: the real model, a frozen clock (Friday 13 Nov 2026), the demo
 * history, and recorded web pages in place of live search, so a case always
 * sees the same world. Everything checkable in code is checked in code. The
 * Groq judge scores conversation quality only.
 */

interface Check {
  name: string;
  pass: boolean;
}

interface Run {
  outcome: TurnOutcome;
  tavily: FakeTavily;
  queries: string;
}

interface Case {
  id: string;
  title: string;
  question: string;
  history: 'demo' | 'empty';
  checks: (r: Run) => Check[];
}

const has = (text: string, re: RegExp) => re.test(text);
const linked = (text: string) => /\]\(https?:\/\/[^)\s]+\)/.test(text) && !text.includes('【');
const searchedAll = (queries: string, names: RegExp[]) => names.every((n) => has(queries, n));
const NO_RECORD = /no record|no conversation|nothing (recorded|on|from|was)|(don['’]t|do not|didn['’]t|did not|haven['’]t|have not) (have|find|see)|isn't any|is no|not recorded|no messages|no earlier/i;

const CASES: Case[] = [
  {
    id: 'crm-since-monday',
    title: 'Challenge example 1: five tools shortlisted on Monday, anything changed?',
    question: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    history: 'demo',
    checks: ({ outcome, tavily, queries }) => [
      { name: 'recalled Monday’s turn', pass: outcome.debug.exactTurns.length === 1 },
      { name: 'searched all five tools', pass: searchedAll(queries, [/hubspot/i, /pipedrive/i, /zoho/i, /salesforce/i, /fresh(sales|works)/i]) },
      { name: 'asked for recent news', pass: tavily.searches.some((s) => s.topic === 'news') },
      { name: 'found the Pipedrive change ($29 to $34)', pass: has(outcome.answer, /pipedrive/i) && has(outcome.answer, /\$?34/) },
      { name: 'cites with markdown links', pass: linked(outcome.answer) },
    ],
  },
  {
    id: 'postgres-last-tuesday',
    title: 'Challenge example 3: "last Tuesday" Postgres hosting, any pricing change?',
    question: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    history: 'demo',
    checks: ({ outcome, queries }) => [
      { name: 'recalled the Postgres turn', pass: outcome.debug.exactTurns.length === 1 },
      { name: 'used the other reading of "last Tuesday"', pass: outcome.debug.dateRefs[0]?.usedAlt === true },
      { name: 'told the user which date it used', pass: has(outcome.answer, /3 nov|nov(ember)? 3|tuesday,? 3/i) },
      { name: 'searched all three hosts', pass: searchedAll(queries, [/supabase/i, /neon/i, /railway/i]) },
      { name: 'cites with markdown links', pass: linked(outcome.answer) },
    ],
  },
  {
    id: 'ask-3-november',
    title: 'Challenge example 2: what did I ask on 3 November, is it still correct?',
    question: 'What did I ask you on 3 November? Is your answer still correct today?',
    history: 'demo',
    checks: ({ outcome, queries }) => [
      { name: 'recalled the 3 November turn', pass: outcome.debug.exactTurns.length === 1 },
      { name: 'names the topic (Postgres hosting)', pass: has(outcome.answer, /postgres/i) },
      { name: 'rechecked with a search', pass: outcome.searches.length >= 1 && has(queries, /supabase|neon|railway/i) },
      { name: 'states the old figure ($25)', pass: has(outcome.answer, /\$25/) },
      { name: 'cites with markdown links', pass: linked(outcome.answer) },
    ],
  },
  {
    id: 'abstain-empty',
    title: 'No history at all: must say there is no record, not invent one',
    question: 'What did I ask you on 3 November?',
    history: 'empty',
    checks: ({ outcome }) => [
      { name: 'did not search', pass: outcome.searches.length === 0 },
      { name: 'says there is no record', pass: has(outcome.answer, NO_RECORD) },
    ],
  },
  {
    id: 'abstain-wrong-day',
    title: 'History exists, but not for that day: says so and points to the nearest day',
    question: 'What did I ask you on 5 November?',
    history: 'demo',
    checks: ({ outcome }) => [
      { name: 'did not search', pass: outcome.searches.length === 0 },
      { name: 'says there is no record', pass: has(outcome.answer, NO_RECORD) },
      { name: 'does not claim a Postgres or CRM question was asked on the 5th', pass: !has(outcome.answer, /on 5 november[^.]*(you asked|asked me)[^.]*(postgres|crm)/i) },
    ],
  },
  {
    id: 'no-search-thanks',
    title: 'Small talk needs no search and no padding',
    question: 'Thanks, that is helpful.',
    history: 'demo',
    checks: ({ outcome }) => [
      { name: 'did not search', pass: outcome.searches.length === 0 },
      { name: 'short reply', pass: outcome.answer.length < 300 },
    ],
  },
  {
    id: 'fresh-fact',
    title: 'A fact that changes: must search and cite',
    question: 'What is the current LTS version of Node.js?',
    history: 'empty',
    checks: ({ outcome }) => [
      { name: 'searched', pass: outcome.searches.length >= 1 },
      { name: 'answers 24', pass: has(outcome.answer, /\b24\b/) },
      { name: 'links the source', pass: has(outcome.answer, /\]\(https?:\/\/[^)]*nodejs\.org/i) && !outcome.answer.includes('【') },
    ],
  },
  {
    id: 'stable-fact',
    title: 'A stable fact: answer directly without searching',
    question: 'What does ACID stand for in databases?',
    history: 'empty',
    checks: ({ outcome }) => [
      { name: 'did not search', pass: outcome.searches.length === 0 },
      { name: 'names all four properties', pass: ['atomic', 'consisten', 'isolat', 'durab'].every((w) => has(outcome.answer, new RegExp(w, 'i'))) },
    ],
  },
];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const sec = (ms: number | null) => (ms == null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`);

async function main() {
  requireKeys(agentKeys().filter((k) => k !== 'tavilyKey'));
  const args = process.argv.slice(2);
  const useJudge = !args.includes('--no-judge') && judgeAvailable();
  const wanted = args.filter((a) => !a.startsWith('--'));
  const cases = wanted.length ? CASES.filter((c) => wanted.some((w) => c.id.includes(w))) : CASES;
  if (!cases.length) throw new Error(`No case matches ${wanted.join(', ')}. Cases: ${CASES.map((c) => c.id).join(', ')}`);

  const llm = createAgentLLM();
  await llm.verify();
  const clock = frozenClock(DEMO_NOW, config.tz);
  console.log(`\nEval: ${cases.length} case(s), agent ${config.agentModel} on ${config.agentProvider} (reasoning ${config.agentEffort}), judge ${useJudge ? judgeLabel() : 'off'}, clock ${DEMO_NOW} ${config.tz}\n`);

  const rows: Array<{
    id: string; title: string; checks: Check[]; ttftMs: number | null; totalMs: number | null; waitedMs: number;
    verdict: Verdict | null; error?: string; answer?: string;
  }> = [];

  for (const c of cases) {
    const store = new Store(':memory:');
    if (c.history === 'demo') seedDemo(store, config.tz);
    const tavily = freshWorld();
    process.stdout.write(`• ${c.id} ... `);
    try {
      const outcome = await handleTurn({ store, clock, llm, tavily, tokenBudget: config.contextTokens }, { text: c.question }, () => {});
      const run: Run = { outcome, tavily, queries: outcome.searches.map((s) => s.query).join(' | ') };
      const checks = c.checks(run);
      let verdict: Verdict | null = null;
      if (useJudge) {
        const runs = outcome.assistantId ? store.runsFor(outcome.assistantId) : [];
        const found = runs.flatMap((r) => r.evidence.map((e) => `- ${e.title} <${e.url}> ${e.published_date ?? ''}: ${e.content_excerpt.slice(0, 300).replace(/\s+/g, ' ')}`)).join('\n');
        // the judge sees what the assistant saw: recalled memory and the pages it read
        const sources = `${outcome.memoryText}\n\nPAGES READ THIS TURN:\n${found || '(none)'}`;
        verdict = await judge({ question: c.question, sources, answer: outcome.answer });
      }
      const passed = checks.filter((k) => k.pass).length;
      // time spent waiting out a provider rate limit is not model time
      const active = outcome.totalMs - outcome.waitedMs;
      const ttft = outcome.waitedMs === 0 ? outcome.ttftMs : null;
      console.log(`${passed}/${checks.length} checks, first output ${sec(ttft)}, total ${sec(active)}${outcome.waitedMs ? ` (+${sec(outcome.waitedMs)} rate-limit wait)` : ''}${verdict ? `, judge ${verdict.directness}/${verdict.citations}/${verdict.honesty}` : ''}`);
      for (const k of checks.filter((k) => !k.pass)) console.log(`    ✗ ${k.name}`);
      rows.push({ id: c.id, title: c.title, checks, ttftMs: ttft, totalMs: active, waitedMs: outcome.waitedMs, verdict, answer: outcome.answer });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERROR ${message}`);
      rows.push({ id: c.id, title: c.title, checks: [], ttftMs: null, totalMs: null, waitedMs: 0, verdict: null, error: message });
      if (err instanceof QuotaError) {
        console.log('\nStopping: the model quota is used up. The cases that ran are reported below.');
        break;
      }
    } finally {
      store.close();
    }
  }

  const ran = rows.filter((r) => !r.error);
  const allChecks = ran.flatMap((r) => r.checks);
  const verdicts = ran.map((r) => r.verdict).filter((v): v is Verdict => !!v && v.directness > 0);
  const avg = (f: (v: Verdict) => number) => (verdicts.length ? (verdicts.reduce((a, v) => a + f(v), 0) / verdicts.length).toFixed(2) : 'n/a');

  const lines: string[] = [];
  lines.push(`# Eval results`, '');
  lines.push(`Agent \`${config.agentModel}\` on ${config.agentProvider} (reasoning: ${config.agentEffort}), judge ${useJudge ? `\`${judgeLabel()}\`` : 'off'}, clock ${DEMO_NOW} ${config.tz}, recorded web pages.`, '');
  lines.push(`Deterministic checks passed: **${allChecks.filter((k) => k.pass).length} / ${allChecks.length}** across ${ran.length} case(s).`);
  lines.push(`Latency (median, rate-limit waits excluded): first output **${sec(median(ran.map((r) => r.ttftMs).filter((x): x is number => x != null)))}**, total **${sec(median(ran.map((r) => r.totalMs).filter((x): x is number => x != null)))}**. Time spent waiting out provider rate limits: ${sec(ran.reduce((n, r) => n + r.waitedMs, 0))} in total.`);
  if (verdicts.length) lines.push(`Judge averages (1 to 5): directness **${avg((v) => v.directness)}**, citations **${avg((v) => v.citations)}**, honesty **${avg((v) => v.honesty)}**.`);
  lines.push('', '| Case | Checks | First output | Total | Judge (dir/cite/honest) |', '| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const p = r.checks.filter((k) => k.pass).length;
    lines.push(`| ${r.id} | ${r.error ? 'error' : `${p}/${r.checks.length}`} | ${sec(r.ttftMs)} | ${sec(r.totalMs)} | ${r.verdict && r.verdict.directness ? `${r.verdict.directness}/${r.verdict.citations}/${r.verdict.honesty}` : '-'} |`);
  }
  const failed = rows.flatMap((r) => r.checks.filter((k) => !k.pass).map((k) => `- **${r.id}**: ${k.name}`));
  if (failed.length) lines.push('', '## Checks that failed', ...failed);
  const errors = rows.filter((r) => r.error);
  if (errors.length) lines.push('', '## Cases that did not run', ...errors.map((r) => `- **${r.id}**: ${r.error}`));
  lines.push('', '## Judge notes', ...rows.filter((r) => r.verdict?.notes).map((r) => `- **${r.id}**: ${r.verdict!.notes}`));
  const out = path.join(ROOT, 'evals', 'RESULTS.md');
  writeFileSync(out, lines.join('\n') + '\n');
  writeFileSync(path.join(ROOT, 'evals', 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${lines.slice(2, 6).join('\n')}\n\nWritten to evals/RESULTS.md\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});

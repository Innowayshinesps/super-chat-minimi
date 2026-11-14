import type { Clock } from './clock.ts';
import type { HistoryTurn } from './context.ts';
import type { LLM, Msg, ToolResult } from './llm.ts';
import { tidyAnswer, tidyDelta } from './tidy.ts';
import { type SearchRun, type TavilyLike, type WebSearchArgs, webSearch } from './search.ts';

/**
 * One agent loop. The model sees one tool, web_search. It may call it
 * (several queries in parallel), read the results, and answer. The loop
 * ends as soon as the model answers without a tool call.
 */

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'search'; queries: string[]; freshness: string }
  | { type: 'sources'; sources: Array<{ title: string; url: string; published_date: string | null }> }
  | { type: 'wait'; seconds: number; why: string }
  | { type: 'notice'; text: string };

export interface AgentResult {
  answer: string;
  runs: SearchRun[];
  steps: number;
  /** ms spent waiting out a provider rate limit (not model time). */
  waitedMs: number;
  /** ms from start of the turn to the first visible model output (text or a search). */
  firstOutputMs: number | null;
  usage: { promptTokens: number; outputTokens: number };
}

/** Most model calls in one turn: up to three rounds of searching, then a forced answer. */
const MAX_STEPS = 4;

/** Page text across all rounds of one turn, in characters. Keeps a whole turn under Groq's 8,000 tokens a minute. */
const TURN_RESULT_CHARS = 10000;

export async function runAgent(args: {
  llm: LLM;
  tavily: TavilyLike;
  clock: Clock;
  system: string;
  history: HistoryTurn[];
  userText: string;
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal;
  startedAt?: number;
}): Promise<AgentResult> {
  const { llm, tavily, clock, system, history, userText, emit, signal } = args;
  const t0 = args.startedAt ?? Date.now();
  const messages: Msg[] = [...history.map((h): Msg => ({ role: h.role, text: h.text })), { role: 'user', text: userText }];
  const runs: SearchRun[] = [];
  const usage = { promptTokens: 0, outputTokens: 0 };
  let firstOutputMs: number | null = null;
  const answerParts: string[] = [];
  const seenSources: Array<{ title: string; url: string }> = [];
  let steps = 0;
  let waitedMs = 0;
  let resultChars = 0;

  const markFirst = () => {
    if (firstOutputMs === null) firstOutputMs = Date.now() - t0;
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    steps++;
    const allowTools = step < MAX_STEPS - 1;
    let stepText = '';
    // text from an earlier step (before a search) and this step's text are separate paragraphs
    let separator = answerParts.length ? '\n\n' : '';
    const res = await llm.step({ system, messages, allowTools, signal, onWait: (seconds, why) => {
        waitedMs += seconds * 1000;
        emit({ type: 'wait', seconds, why });
      }, onNotice: (text) => emit({ type: 'notice', text }) }, (raw) => {
      const delta = tidyDelta(raw);
      markFirst();
      stepText += delta;
      emit({ type: 'delta', text: separator + delta });
      separator = '';
    });
    usage.promptTokens += res.usage?.promptTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    if (stepText.trim()) answerParts.push(stepText.trim());

    if (!res.calls.length) {
      if (!answerParts.length) {
        throw new Error(
          res.finishReason && !/STOP/i.test(res.finishReason)
            ? `The model stopped without an answer (${res.finishReason}).`
            : 'The model returned an empty answer.',
        );
      }
      break;
    }

    // run every tool call from this step at the same time
    messages.push({ role: 'assistant', text: res.text, calls: res.calls, raw: res.raw });
    const results: ToolResult[] = await Promise.all(
      res.calls.map(async (call): Promise<ToolResult> => {
        if (call.name !== 'web_search') {
          return { id: call.id, name: call.name, response: { error: `Unknown tool "${call.name}". Only web_search exists.` } };
        }
        const a = call.args as unknown as WebSearchArgs;
        markFirst();
        emit({ type: 'search', queries: Array.isArray(a.queries) ? a.queries.map(String) : [], freshness: String(a.freshness ?? 'any') });
        // all rounds are resent with every later model call, so one budget covers the whole turn
        const out = await webSearch(a, { tavily, clock, budgetChars: Math.max(3000, TURN_RESULT_CHARS - resultChars) });
        resultChars += JSON.stringify(out.response).length;
        runs.push(...out.runs);
        seenSources.push(...out.sources);
        emit({ type: 'sources', sources: out.sources });
        return { id: call.id, name: call.name, response: out.response };
      }),
    );
    messages.push({ role: 'tool', results });
  }

  return { answer: tidyAnswer(answerParts.join('\n\n'), seenSources), runs, steps, waitedMs, firstOutputMs, usage };
}

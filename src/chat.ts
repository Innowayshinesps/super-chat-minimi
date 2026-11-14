import { randomUUID } from 'node:crypto';
import { type AgentEvent, runAgent } from './agent.ts';
import type { Clock } from './clock.ts';
import { buildContext, type ContextDebug } from './context.ts';
import { type Store, titleFrom } from './db.ts';
import type { LLM } from './llm.ts';
import type { TavilyLike } from './search.ts';

export interface TurnDeps {
  store: Store;
  clock: Clock;
  llm: LLM;
  tavily: TavilyLike;
  tokenBudget: number;
}

export type TurnEvent =
  | AgentEvent
  | { type: 'chat'; id: string; title: string; isNew: boolean }
  | { type: 'context'; debug: ContextDebug }
  | {
      type: 'done';
      chatId: string;
      messageId: string;
      ttftMs: number | null;
      totalMs: number;
      steps: number;
      waitedMs: number;
      text: string;
      searches: number;
      usage: { promptTokens: number; outputTokens: number };
    }
  | { type: 'error'; message: string };

export interface TurnOutcome {
  chatId: string;
  answer: string;
  assistantId: string | null;
  debug: ContextDebug;
  searches: Array<{ query: string; urls: string[] }>;
  ttftMs: number | null;
  totalMs: number;
  waitedMs: number;
  /** The Memory section the model was given, for the eval's judge. */
  memoryText: string;
}

/**
 * One chat turn, end to end:
 *   context (code) -> agent loop (model + web_search) -> answer -> save.
 * A turn that fails is not saved, so memory never holds a half-turn. A turn the
 * user stops is saved with the text that had streamed.
 */
export async function handleTurn(
  deps: TurnDeps,
  input: { chatId?: string; text: string; signal?: AbortSignal },
  emit: (e: TurnEvent) => void,
): Promise<TurnOutcome> {
  const { store, clock } = deps;
  const text = input.text.trim();
  if (!text) throw new Error('Empty message.');
  const startedAt = Date.now();
  const userAt = clock.now();

  let chat = input.chatId ? store.getChat(input.chatId) : undefined;
  const isNew = !chat;
  if (!chat) chat = store.createChat(titleFrom(text), userAt);
  emit({ type: 'chat', id: chat.id, title: chat.title, isNew });

  const ctx = buildContext(store, clock, chat.id, text, { tokenBudget: deps.tokenBudget });
  emit({ type: 'context', debug: ctx.debug });

  let streamed = '';
  const forward = (e: AgentEvent) => {
    if (e.type === 'delta') streamed += e.text;
    emit(e);
  };

  const userId = randomUUID();
  const assistantId = randomUUID();
  try {
    const res = await runAgent({
      llm: deps.llm,
      tavily: deps.tavily,
      clock,
      system: ctx.system,
      history: ctx.history,
      userText: text,
      emit: forward,
      signal: input.signal,
      startedAt,
    });
    const totalMs = Date.now() - startedAt;
    store.saveTurn({
      chatId: chat.id,
      userId,
      assistantId,
      userText: text,
      assistantText: res.answer,
      userAt,
      assistantAt: clock.now(),
      ttftMs: res.firstOutputMs,
      totalMs,
      searches: res.runs,
    });
    emit({
      type: 'done',
      chatId: chat.id,
      messageId: assistantId,
      ttftMs: res.firstOutputMs,
      totalMs,
      steps: res.steps,
      waitedMs: res.waitedMs,
      text: res.answer,
      searches: res.runs.length,
      usage: res.usage,
    });
    return {
      chatId: chat.id,
      answer: res.answer,
      assistantId,
      debug: ctx.debug,
      searches: res.runs.map((r) => ({ query: r.query, urls: r.evidence.map((e) => e.url) })),
      ttftMs: res.firstOutputMs,
      totalMs,
      waitedMs: res.waitedMs,
      memoryText: ctx.system.slice(ctx.system.indexOf('## Memory')),
    };
  } catch (err) {
    if (input.signal?.aborted && streamed.trim()) {
      const totalMs = Date.now() - startedAt;
      store.saveTurn({
        chatId: chat.id,
        userId,
        assistantId,
        userText: text,
        assistantText: streamed.trim(),
        userAt,
        assistantAt: clock.now(),
        ttftMs: null,
        totalMs,
        searches: [],
      });
      return { chatId: chat.id, answer: streamed.trim(), assistantId, debug: ctx.debug, searches: [], ttftMs: null, totalMs, waitedMs: 0, memoryText: '' };
    }
    throw err;
  }
}

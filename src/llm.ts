/**
 * The model boundary. The agent speaks in these provider-neutral messages;
 * `gemini.ts` and `groq.ts` translate them. Swapping the provider, or faking it
 * in tests, never touches the agent.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export type Msg =
  | { role: 'user'; text: string }
  /** `raw` is whatever the provider needs replayed exactly (Gemini keeps reasoning signatures there). */
  | { role: 'assistant'; text: string; calls?: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface StepRequest {
  system: string;
  messages: Msg[];
  /** false forces a plain answer (used on the last allowed step). */
  allowTools: boolean;
  signal?: AbortSignal;
  /** Called when the provider asks us to wait (a per-minute limit), so the page can say so. */
  onWait?: (seconds: number, why: string) => void;
  /** Called when the turn moves to a backup model, so the page can say so. */
  onNotice?: (text: string) => void;
  /** Wait out a per-minute limit however long it is, instead of handing the turn to a backup. */
  patient?: boolean;
}

export interface StepResult {
  text: string;
  calls: ToolCall[];
  raw?: unknown;
  finishReason?: string;
  usage?: { promptTokens?: number; outputTokens?: number };
}

export interface LLM {
  step(req: StepRequest, onText: (delta: string) => void): Promise<StepResult>;
}

/** The provider says the quota is used up. Retrying will not help, so it is not retried. */
export class QuotaError extends Error {
  /** quota: daily limit used up; rate: a per-minute wait too long to sit through; size: one request over the per-minute cap. */
  constructor(message: string, readonly reason: 'quota' | 'rate' | 'size' = 'quota') {
    super(message);
    this.name = 'QuotaError';
  }
}

/** Two user turns, or two assistant turns, in a row are one turn; the conversation starts with the user. */
export function normalize(messages: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === 'user' && m.role === 'user') {
      out[out.length - 1] = { role: 'user', text: `${last.text}\n\n${m.text}` };
    } else if (last && last.role === 'assistant' && m.role === 'assistant' && !last.calls && !m.calls) {
      out[out.length - 1] = { role: 'assistant', text: `${last.text}\n\n${m.text}` };
    } else {
      out.push(m);
    }
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** "Please retry in 18h25m32.6s" / "try again in 7.5s" -> seconds. */
export function retryAfterSeconds(message: string): number | undefined {
  const m = /(?:retry|try again) in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/i.exec(message);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function quotaMessage(who: string, raw: string): string {
  const wait = retryAfterSeconds(raw);
  const when = wait ? ` It resets in about ${wait >= 3600 ? Math.round(wait / 3600) + ' h' : Math.max(1, Math.round(wait / 60)) + ' min'}.` : '';
  return `The ${who} quota is used up on this key.${when} Link billing to the key's provider account, or set AGENT_MODEL / AGENT_PROVIDER in .env to one with quota left.`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A request with no first token after this long is abandoned and retried. */
export const FIRST_TOKEN_TIMEOUT_MS = 25000;
export const MAX_ATTEMPTS = 5;
/** A per-minute rate limit that clears within this long is waited out; longer means a daily quota. */
export const MAX_WAIT_S = 90;

/** Daily limits will not clear by waiting; per-minute limits will. */
export const isDailyLimit = (raw: string) => /per day|TPD|RPD|PerDay|requests per day/i.test(raw);

export function isTransientStatus(status: number | undefined, message: string): boolean {
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  return /high demand|overloaded|UNAVAILABLE|ECONNRESET|fetch failed|terminated|no first token|over capacity|tool_use_failed|failed to call a function/i.test(message);
}

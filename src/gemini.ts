import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
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

/** Gemini adapter: the only place that knows Gemini's message and tool format. */

const LEVELS: Record<string, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.XHIGH,
};

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; message?: string };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  const m = /"code":\s*(\d{3})/.exec(e?.message ?? '');
  return m ? Number(m[1]) : undefined;
}

export function toContents(messages: Msg[]): Content[] {
  const out: Content[] = [];
  for (const m of normalize(messages)) {
    if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.text }] });
    else if (m.role === 'assistant') {
      if (m.raw) out.push({ role: 'model', parts: m.raw as Part[] });
      else {
        const parts: Part[] = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.calls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
        out.push({ role: 'model', parts });
      }
    } else {
      out.push({
        role: 'user',
        parts: m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.response } })) as Part[],
      });
    }
  }
  return out;
}

export function geminiLLM(opts: {
  apiKey: string;
  model: string;
  tools: ToolSpec[];
  effort: string;
}): LLM & { verify(): Promise<void> } {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const level = LEVELS[opts.effort.toLowerCase()];
  if (!level) throw new Error(`AGENT_EFFORT for Gemini must be one of ${Object.keys(LEVELS).join(', ')} (got "${opts.effort}")`);
  const tools = [
    { functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) },
  ];

  return {
    /** Fail early, with a useful message, if the key cannot see the configured model. */
    async verify() {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}`, {
        headers: { 'x-goog-api-key': opts.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) return;
      if (r.status === 404) {
        throw new Error(`Your Gemini key cannot see the model "${opts.model}". Set AGENT_MODEL in .env to one it can.`);
      }
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        throw new Error(`Gemini rejected the API key (HTTP ${r.status}). Check GEMINI_API_KEY in .env.`);
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

        const parts: Part[] = [];
        const calls: ToolCall[] = [];
        let text = '';
        let finishReason: string | undefined;
        let usage: StepResult['usage'];

        const handle = (chunk: GenerateContentResponse) => {
          const cand = chunk.candidates?.[0];
          if (cand?.finishReason) finishReason = String(cand.finishReason);
          if (chunk.usageMetadata) {
            usage = { promptTokens: chunk.usageMetadata.promptTokenCount, outputTokens: chunk.usageMetadata.candidatesTokenCount };
          }
          for (const part of cand?.content?.parts ?? []) {
            if (part.thought) continue; // reasoning summaries are never shown or replayed as text
            if (part.functionCall) {
              calls.push({
                id: part.functionCall.id ?? `call_${calls.length}`,
                name: part.functionCall.name ?? '',
                args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              });
              parts.push(part);
            } else if (typeof part.text === 'string') {
              if (part.text) {
                text += part.text;
                onText(part.text);
              }
              const prev = parts[parts.length - 1];
              if (prev && typeof prev.text === 'string' && !prev.thoughtSignature && !part.thoughtSignature && !prev.functionCall) {
                prev.text += part.text;
              } else {
                parts.push({ ...part });
              }
            } else {
              parts.push(part);
            }
          }
        };

        try {
          const stream = await ai.models.generateContentStream({
            model: opts.model,
            contents: toContents(req.messages),
            config: {
              abortSignal: ac.signal,
              systemInstruction: req.system,
              tools: tools as never,
              toolConfig: req.allowTools ? undefined : { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } },
              thinkingConfig: { thinkingLevel: level },
            },
          });
          let first = true;
          for await (const chunk of stream) {
            if (first) {
              first = false;
              clearTimeout(timer);
            }
            handle(chunk);
          }
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onOuter);
          return { text, calls, raw: parts, finishReason, usage };
        } catch (err) {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onOuter);
          if (req.signal?.aborted) throw err;
          lastErr = err;
          const nothingSent = text === '' && calls.length === 0;
          const raw = String((err as Error)?.message ?? '');
          if (statusOf(err) === 429) {
            const wait = retryAfterSeconds(raw);
            if (isDailyLimit(raw) || wait === undefined || wait > MAX_WAIT_S || attempt === MAX_ATTEMPTS - 1) {
              throw new QuotaError(quotaMessage(`Gemini (${opts.model})`, raw));
            }
            req.onWait?.(Math.ceil(wait), 'rate limit');
            await sleep(wait * 1000 + 250);
            continue;
          }
          const retryable = (timedOut || isTransientStatus(statusOf(err), raw)) && nothingSent;
          if (!retryable || attempt === MAX_ATTEMPTS - 1) throw err;
          await sleep(800 * 2 ** attempt + Math.random() * 400);
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

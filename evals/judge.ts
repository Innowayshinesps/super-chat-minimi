import { config } from '../src/config.ts';

/**
 * The judge is a different model family from the agent (Gemini judges the Groq
 * agent, and the other way round), so it does not favour the agent's own
 * style. It scores conversation quality only; everything checkable in code is
 * checked in code (see run.ts).
 */

export interface Verdict {
  directness: number; // 1-5: the first sentence answers the question
  citations: number; // 1-5: claims are backed by relevant inline links
  honesty: number; // 1-5: no invented facts; says "could not verify" / "no record" when true
  notes: string;
}

const RUBRIC = `You grade one answer from a chat assistant that can search the web. Score each 1 to 5 (5 best):
- directness: the first sentence answers the question; short; no filler or restating the question.
- citations: every price, date or claim that can change has an inline markdown link to a relevant source, and links match the claims.
- honesty: no invented facts; says "could not verify" or "no record" when that is the truth; does not turn "found no change" into "nothing changed"; admits ambiguity.
Use only the question, the sources the assistant was given, and the answer. Return ONLY JSON: {"directness":n,"citations":n,"honesty":n,"notes":"one short sentence"}`;

export function judgeLabel(): string {
  return `${config.judgeModel} (${config.judgeProvider})`;
}

export function judgeAvailable(): boolean {
  return config.judgeProvider === 'gemini' ? Boolean(config.judgeGeminiKey) : Boolean(config.groqKey);
}

async function askJudge(user: string): Promise<string> {
  if (config.judgeProvider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.judgeModel}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': config.judgeGeminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RUBRIC }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw Object.assign(new Error(`Gemini judge ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
    const j = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.judgeModel,
      temperature: 0,
      reasoning_effort: 'low',
      messages: [{ role: 'system', content: RUBRIC }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Object.assign(new Error(`Groq judge ${r.status}: ${(await r.text()).slice(0, 160)}`), { status: r.status });
  const j = (await r.json()) as { choices: Array<{ message: { content: string } }> };
  return j.choices[0].message.content;
}

export async function judge(input: { question: string; sources: string; answer: string }): Promise<Verdict | null> {
  if (!judgeAvailable()) return null;
  const user = `QUESTION:
${input.question}

SOURCES THE ASSISTANT HAD:
${input.sources || '(none)'}

ANSWER:
${input.answer}`;
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const text = await askJudge(user);
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) throw new Error('judge returned no JSON');
      const v = JSON.parse(m[0]) as Verdict;
      const clamp = (n: unknown) => Math.max(1, Math.min(5, Number(n) || 1));
      return { directness: clamp(v.directness), citations: clamp(v.citations), honesty: clamp(v.honesty), notes: String(v.notes ?? '') };
    } catch (e) {
      lastErr = (e as Error).message;
      const status = (e as { status?: number }).status;
      if (status === 429 || (status ?? 500) >= 500 || !status) await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));
      else break;
    }
  }
  return { directness: 0, citations: 0, honesty: 0, notes: `judge failed: ${lastErr.slice(0, 120)}` };
}

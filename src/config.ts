import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // an unreadable .env just means the keys must come from the real environment
  }
}

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** A TZ the runtime does not know (some shells export odd values) falls back to the system zone. */
function validZone(name: string): string {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    console.warn(`TZ "${name}" is not a time zone name like Europe/London; using ${system}.`);
    return system;
  }
}

export const config = {
  geminiKey: env('GEMINI_API_KEY'),
  tavilyKey: env('TAVILY_API_KEY'),
  groqKey: env('GROQ_API_KEY'),
  /** The agent: the one model in the live path. */
  agentProvider: (env('AGENT_PROVIDER', 'groq') === 'gemini' ? 'gemini' : 'groq') as 'groq' | 'gemini',
  agentModel: env('AGENT_MODEL', env('AGENT_PROVIDER', 'groq') === 'gemini' ? 'gemini-4-hydrogen' : 'openai/gpt-oss-120b'),
  agentEffort: env('AGENT_EFFORT', 'medium'),
  /** The backup when the agent's quota runs out (the other provider, if its key is set). */
  fallbackModel: env('FALLBACK_MODEL', 'gemini-3.6-flash'),
  fallbackEffort: env('FALLBACK_EFFORT', 'medium'),
  /** The eval judge: always the other provider, so it is a different model family from the agent. */
  judgeProvider: (env('AGENT_PROVIDER', 'groq') === 'gemini' ? 'groq' : 'gemini') as 'groq' | 'gemini',
  judgeModel: env('JUDGE_MODEL', env('AGENT_PROVIDER', 'groq') === 'gemini' ? 'openai/gpt-oss-120b' : 'gemini-3.6-flash'),
  judgeGeminiKey: env('GEMINI_JUDGE_API_KEY', env('GEMINI_API_KEY')),
  port: Number(env('PORT', '3000')),
  dbPath: env('DB_PATH', path.join(ROOT, 'data', 'minimi.db')),
  nowOverride: env('NOW'),
  tz: validZone(env('TZ', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')),
  /** Rough token budget for everything we put in front of the model besides the policy. */
  // Groq's free tier caps one minute at 8,000 tokens, and a search turn also carries the policy and page text,
  // so on Groq the memory stays small.
  contextTokens: Number(env('CONTEXT_TOKENS', env('AGENT_PROVIDER', 'groq') === 'gemini' ? '12000' : '3200')),
};

export function requireKeys(names: Array<'geminiKey' | 'tavilyKey' | 'groqKey'>): void {
  const label = { geminiKey: 'GEMINI_API_KEY', tavilyKey: 'TAVILY_API_KEY', groqKey: 'GROQ_API_KEY' };
  const missing = names.filter((n) => !config[n]).map((n) => label[n]);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
}

/** The key the chosen agent provider needs, plus search. */
export const agentKeys = (): Array<'geminiKey' | 'tavilyKey' | 'groqKey'> => [
  config.agentProvider === 'groq' ? 'groqKey' : 'geminiKey',
  'tavilyKey',
];

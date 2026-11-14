import { config } from './config.ts';
import { FallbackLLM } from './fallback.ts';
import { geminiLLM } from './gemini.ts';
import { groqLLM } from './groq.ts';
import type { LLM } from './llm.ts';
import { WEB_SEARCH } from './search.ts';

/**
 * The agent's model, chosen by AGENT_PROVIDER / AGENT_MODEL / AGENT_EFFORT. If the
 * other provider's key is set, that provider is the backup when the main quota
 * runs out. The agent only ever sees `LLM`.
 */
export function createAgentLLM(): LLM & { verify(): Promise<void>; backup: string | null } {
  const tools = [WEB_SEARCH];
  const backupKey = config.agentProvider === 'gemini' ? config.groqKey : config.geminiKey;
  const main =
    config.agentProvider === 'gemini'
      ? geminiLLM({ apiKey: config.geminiKey, model: config.agentModel, tools, effort: config.agentEffort })
      : groqLLM({ apiKey: config.groqKey, model: config.agentModel, tools, effort: config.agentEffort, switchAfterS: backupKey ? 10 : undefined });

  if (!backupKey) return Object.assign(main, { backup: null });
  const backupModel = config.agentProvider === 'gemini' ? 'openai/gpt-oss-120b' : config.fallbackModel;
  const backup =
    config.agentProvider === 'gemini'
      ? groqLLM({ apiKey: backupKey, model: backupModel, tools, effort: 'medium' })
      : geminiLLM({ apiKey: backupKey, model: backupModel, tools, effort: config.fallbackEffort });
  const llm = new FallbackLLM(main, backup, { primary: config.agentModel, secondary: backupModel });
  return Object.assign(llm, { verify: () => main.verify(), backup: backupModel });
}

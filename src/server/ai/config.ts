import { createOpenAIStructuredClient } from "./openai-client";
import type { StructuredLLMClient } from "./types";

export const DEFAULT_ONBOARDING_MODEL = "gpt-4.1-mini";

/**
 * The structured-generation client used for onboarding, or null when no
 * provider is configured. Callers must handle null explicitly (deterministic
 * fallback that is labelled as such) — never pretend output came from AI.
 */
export function getOnboardingLLM(env: NodeJS.ProcessEnv = process.env): StructuredLLMClient | null {
  if (!env.OPENAI_API_KEY) return null;
  // 40 s per attempt keeps worst-case retries inside the onboarding routes' maxDuration (300 s).
  return createOpenAIStructuredClient({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_ONBOARDING_MODEL || DEFAULT_ONBOARDING_MODEL, timeoutMs: 40_000 });
}

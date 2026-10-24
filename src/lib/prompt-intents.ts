import type { PromptIntent } from "@/generated/prisma/enums";

export const PROMPT_INTENTS = ["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "COMPARISON", "ALTERNATIVE", "BRANDED"] as const satisfies readonly PromptIntent[];

/** Target mix for the initial 30 prompts, weighted toward commercially valuable intents. */
export const PROMPT_DISTRIBUTION: Record<PromptIntent, number> = {
  INFORMATIONAL: 5,
  COMMERCIAL: 8,
  TRANSACTIONAL: 4,
  COMPARISON: 5,
  ALTERNATIVE: 4,
  BRANDED: 4,
};

export const TOTAL_INITIAL_PROMPTS = Object.values(PROMPT_DISTRIBUTION).reduce((a, b) => a + b, 0);

export const INTENT_LABELS: Record<PromptIntent, { label: string; hint: string }> = {
  INFORMATIONAL: { label: "Informational", hint: "Problem and how-to questions" },
  COMMERCIAL: { label: "Commercial", hint: "Best-of and shortlist questions" },
  TRANSACTIONAL: { label: "Transactional", hint: "Pricing, buying and sign-up intent" },
  COMPARISON: { label: "Comparison", hint: "X vs Y" },
  ALTERNATIVE: { label: "Alternative", hint: "Alternatives to a competitor" },
  BRANDED: { label: "Branded", hint: "Questions about your brand" },
};

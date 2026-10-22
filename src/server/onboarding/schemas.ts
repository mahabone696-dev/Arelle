/**
 * Zod contracts for onboarding. AI output schemas are defined first and
 * every AI response is validated against them; user edits have their own
 * input schemas. Strict-mode compatible: all fields required (use "" / []).
 */
import { z } from "zod";
import { PROMPT_INTENTS } from "./intents";

const shortText = (max: number) => z.string().trim().max(max);
const list = (maxItems: number, maxLen = 120) => z.array(shortText(maxLen).min(1)).max(maxItems);

// ── AI output: brand extraction ───────────────────────────────
export const brandExtractionSchema = z.object({
  brandName: shortText(80).min(1),
  description: shortText(600),
  industry: shortText(120),
  products: list(12),
  services: list(12),
  targetCustomers: list(10),
  markets: list(10),
  topics: list(15),
});
export type BrandExtraction = z.infer<typeof brandExtractionSchema>;

// ── AI output: competitors ────────────────────────────────────
export const competitorSuggestionsSchema = z.object({
  competitors: z
    .array(
      z.object({
        name: shortText(80).min(1),
        domain: shortText(253),
        reason: shortText(300),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(10),
});
export type CompetitorSuggestion = z.infer<typeof competitorSuggestionsSchema>["competitors"][number];

// ── AI output: prompts ────────────────────────────────────────
export const generatedPromptSchema = z.object({
  text: shortText(200).min(3),
  intent: z.enum(PROMPT_INTENTS),
  cluster: shortText(60).min(1),
  priority: z.number().int().min(1).max(5),
  country: z.string().trim().length(2),
  language: z.string().trim().min(2).max(8),
  reason: shortText(300).min(1),
});
export type GeneratedPrompt = z.infer<typeof generatedPromptSchema>;

export const generatedPromptsSchema = z.object({ prompts: z.array(generatedPromptSchema).min(1).max(40) });

// ── User input: brand profile edits ───────────────────────────
const editableList = (maxItems: number) =>
  z
    .array(z.string().trim().max(120))
    .max(maxItems)
    .transform((xs) => [...new Set(xs.filter(Boolean))]);

export const brandProfileInputSchema = z.object({
  brandName: z.string().trim().min(1, "Enter the brand name").max(80),
  industry: z.string().trim().min(2, "Describe the category, e.g. “CRM software”").max(120),
  description: z.string().trim().max(600),
  products: editableList(12),
  services: editableList(12),
  targetCustomers: editableList(10),
  markets: editableList(10),
  topics: editableList(15),
  aliases: editableList(10),
});
export type BrandProfileInput = z.input<typeof brandProfileInputSchema>;

// ── User input: competitors ───────────────────────────────────
export const MAX_COMPETITORS = 10;
export const competitorInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Enter a name").max(80),
  domain: z.string().trim().max(253).optional().default(""),
});
export const competitorsInputSchema = z
  .array(competitorInputSchema)
  .max(MAX_COMPETITORS, `Track up to ${MAX_COMPETITORS} competitors`)
  .refine((xs) => new Set(xs.map((c) => c.name.toLowerCase())).size === xs.length, "Competitor names must be unique");

// ── User input: prompt review ─────────────────────────────────
export const MAX_PROMPTS_PER_PROJECT = 200;
export const promptReviewItemSchema = z.object({
  id: z.string().optional(),
  text: z.string().trim().min(3, "Prompt is too short").max(200, "Prompt is too long"),
  intent: z.enum(PROMPT_INTENTS),
  cluster: z.string().trim().min(1).max(60),
  priority: z.number().int().min(1).max(5),
  approved: z.boolean(),
});
export const promptReviewSchema = z.object({
  prompts: z.array(promptReviewItemSchema).max(MAX_PROMPTS_PER_PROJECT),
  deletedIds: z.array(z.string()).max(MAX_PROMPTS_PER_PROJECT).default([]),
  finish: z.boolean().default(false),
});
export type PromptReviewInput = z.input<typeof promptReviewSchema>;

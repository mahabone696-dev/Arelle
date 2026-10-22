import { z } from "zod";
import { normalizeDomain } from "@/lib/domain";
import { isSupportedCountry, isSupportedLanguage, isValidTimezone } from "@/lib/i18n";

export const domainSchema = z.string().transform((value, ctx) => {
  const result = normalizeDomain(value);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.domain;
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80, "Name is too long"),
  domain: domainSchema,
  country: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCountry, "Choose a supported country"),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .refine(isSupportedLanguage, "Choose a supported language"),
  timezone: z.string().trim().default("UTC").refine(isValidTimezone, "Choose a valid timezone"),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.omit({ domain: true }).partial();
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;

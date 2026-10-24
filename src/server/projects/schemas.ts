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

const projectNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(80, "Name is too long");
const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isSupportedCountry, "Choose a supported country");
const languageSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isSupportedLanguage, "Choose a supported language");
const timezoneSchema = z.string().trim().refine(isValidTimezone, "Choose a valid timezone");

export const createProjectSchema = z.object({
  name: projectNameSchema,
  domain: domainSchema,
  country: countrySchema,
  language: languageSchema,
  timezone: timezoneSchema.default("UTC"),
});

export type CreateProjectInput = z.input<typeof createProjectSchema>;

// Built without defaults: Zod 4 applies .default() inside .partial(), which
// would silently reset omitted fields on update.
export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  country: countrySchema.optional(),
  language: languageSchema.optional(),
  timezone: timezoneSchema.optional(),
});
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;

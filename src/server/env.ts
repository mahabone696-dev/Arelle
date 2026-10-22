/**
 * Server environment, validated with Zod on first access. Never import this
 * from client components — it contains secrets.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  AUTH_GOOGLE_ID: optionalString,
  AUTH_GOOGLE_SECRET: optionalString,
  AUTH_GITHUB_ID: optionalString,
  AUTH_GITHUB_SECRET: optionalString,
  PLATFORM_ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  FEATURE_GEMINI: bool,
  FEATURE_PERPLEXITY: bool,
  FEATURE_ACTION_ENGINE: bool,
  FEATURE_BILLING: bool,
  FEATURE_PUBLIC_AUDIT: bool,
  FEATURE_REPORTS: bool,
  REDIS_URL: optionalString,
  SCAN_GLOBAL_DAILY_QUERY_CAP: z.coerce.number().int().positive().default(5000),
  SCAN_MAX_QUERIES_PER_SCAN: z.coerce.number().int().positive().default(1000),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function getEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

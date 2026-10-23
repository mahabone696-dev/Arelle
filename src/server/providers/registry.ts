/**
 * Resolves which answer providers can run a scan right now. A provider is
 * ready only when it is enabled in the database, configured with
 * credentials, implemented, and has known pricing (cost safety: we never
 * dispatch paid queries we can't estimate). Every unavailable provider comes
 * back with a transparent reason.
 */
import { db } from "@/server/db";
import { isFeatureEnabled } from "@/server/flags/flags";
import { logger } from "@/lib/logger";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";
import { PerplexityProvider } from "./perplexity";
import type { AIAnswerProvider } from "./types";

export type UnavailableReason =
  | "DISABLED"
  | "FEATURE_OFF"
  | "NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "PRICING_MISSING"
  | "CHECK_FAILED";

export interface ProviderConfig {
  /** AIProvider row */
  providerId: string;
  slug: string;
  displayName: string;
  maxConcurrency: number;
  requestsPerMinute: number;
  dailyQueryCap: number;
  /** AIModel row id used for this provider's queries. */
  modelRowId: string;
  modelId: string;
}

export interface ReadyProvider extends ProviderConfig {
  adapter: AIAnswerProvider;
}

export interface ProviderAvailability {
  ready: ReadyProvider[];
  unavailable: Array<{ slug: string; displayName: string; reason: UnavailableReason }>;
}

interface Pricing {
  inputCostPer1M: number;
  outputCostPer1M: number;
  requestCost: number;
}

type Factory = (model: string, pricing: Pricing, env: NodeJS.ProcessEnv) => AIAnswerProvider | null;

/** Model id each provider queries, from env. Null = provider not configured. */
function configuredModel(slug: string, env: NodeJS.ProcessEnv): string | null {
  if (slug === "openai") return env.OPENAI_API_KEY ? env.OPENAI_SCAN_MODEL || "gpt-4.1-mini" : null;
  if (slug === "gemini") return env.GEMINI_API_KEY ? env.GEMINI_SCAN_MODEL || "gemini-3.8-flash" : null;
  if (slug === "perplexity") return env.PERPLEXITY_API_KEY ? env.PERPLEXITY_SCAN_MODEL || "perplexity/sonar" : null;
  return null;
}

const FACTORIES: Record<string, Factory> = {
  openai: (model, pricing, env) =>
    new OpenAIProvider({
      apiKey: env.OPENAI_API_KEY!,
      model,
      pricing,
      webSearch: env.OPENAI_SCAN_WEB_SEARCH !== "false",
      baseURL: env.OPENAI_BASE_URL || undefined,
    }),
  gemini: (model, pricing, env) =>
    new GeminiProvider({
      apiKey: env.GEMINI_API_KEY!,
      model,
      pricing,
      thinkingLevel: (["minimal", "low", "medium", "high"] as const).find((l) => l === env.GEMINI_SCAN_THINKING) ?? "low",
      baseURL: env.GEMINI_BASE_URL || undefined,
    }),
  perplexity: (model, pricing, env) =>
    new PerplexityProvider({
      apiKey: env.PERPLEXITY_API_KEY!,
      model,
      pricing,
      maxToolCalls: Number(env.PERPLEXITY_SCAN_MAX_SEARCHES) > 0 ? Number(env.PERPLEXITY_SCAN_MAX_SEARCHES) : 2,
      baseURL: env.PERPLEXITY_BASE_URL || undefined,
    }),
};

/** Providers that have an adapter in this build (workers start one queue consumer per slug). */
export const IMPLEMENTED_PROVIDERS = Object.keys(FACTORIES);

const FEATURE_GATED: Record<string, "gemini" | "perplexity"> = {
  gemini: "gemini",
  perplexity: "perplexity",
};

export async function getProviderAvailability(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderAvailability> {
  const rows = await loadProviderRows();
  const result: ProviderAvailability = { ready: [], unavailable: [] };
  for (const row of rows) {
    const miss = (reason: UnavailableReason) =>
      result.unavailable.push({ slug: row.slug, displayName: row.displayName, reason });
    try {
      await evaluateProvider(row, env, result, miss);
    } catch (error) {
      // One provider's misconfiguration must never take the others down.
      logger.error("providers.availability_check_failed", { provider: row.slug, error });
      miss("CHECK_FAILED");
    }
  }
  return result;
}

type ProviderRow = Awaited<ReturnType<typeof loadProviderRows>>[number];
const loadProviderRows = () =>
  db.aIProvider.findMany({
    include: { models: { where: { isActive: true } } },
    orderBy: { createdAt: "asc" },
  });

async function evaluateProvider(
  row: ProviderRow,
  env: NodeJS.ProcessEnv,
  result: ProviderAvailability,
  miss: (r: UnavailableReason) => void,
): Promise<void> {
  if (!row.isEnabled) {
    miss("DISABLED");
    return;
  }
  if (FEATURE_GATED[row.slug] && !(await isFeatureEnabled(FEATURE_GATED[row.slug]!))) {
    miss("FEATURE_OFF");
    return;
  }
  const factory = FACTORIES[row.slug];
  if (!factory) {
    miss("NOT_IMPLEMENTED");
    return;
  }
  const modelId = configuredModel(row.slug, env);
  if (!modelId) {
    miss("NOT_CONFIGURED");
    return;
  }
  const model = row.models.find((m) => m.modelId === modelId);
  if (!model) {
    miss("PRICING_MISSING");
    return;
  }
  const pricing = {
    inputCostPer1M: Number(model.inputCostPer1M),
    outputCostPer1M: Number(model.outputCostPer1M),
    requestCost: Number(model.requestCost),
  };
  const adapter = factory(modelId, pricing, env);
  if (!adapter) {
    miss("NOT_CONFIGURED");
    return;
  }
  result.ready.push({
    adapter,
    providerId: row.id,
    slug: row.slug,
    displayName: row.displayName,
    maxConcurrency: row.maxConcurrency,
    requestsPerMinute: row.requestsPerMinute,
    dailyQueryCap: row.dailyQueryCap,
    modelRowId: model.id,
    modelId,
  });
}

/** Resolve one ready provider by id (used by workers). Null when it is no longer available. */
export async function getReadyProvider(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadyProvider | null> {
  const { ready } = await getProviderAvailability(env);
  return ready.find((p) => p.providerId === providerId) ?? null;
}

export const UNAVAILABLE_LABELS: Record<UnavailableReason, string> = {
  DISABLED: "Disabled by an administrator",
  FEATURE_OFF: "Not enabled yet",
  NOT_CONFIGURED: "Credentials not configured",
  NOT_IMPLEMENTED: "Coming soon",
  PRICING_MISSING: "Model pricing not configured",
  CHECK_FAILED: "Configuration error",
};

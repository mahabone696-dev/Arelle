/** Feature flag catalogue. Each flag defaults to its FEATURE_* env var. */
export const FEATURE_FLAGS = {
  gemini: { env: "FEATURE_GEMINI", description: "Gemini provider adapter" },
  perplexity: { env: "FEATURE_PERPLEXITY", description: "Perplexity provider adapter" },
  actionEngine: { env: "FEATURE_ACTION_ENGINE", description: "Opportunity & Action Engine" },
  billing: { env: "FEATURE_BILLING", description: "Stripe billing" },
  publicAudit: { env: "FEATURE_PUBLIC_AUDIT", description: "Public /audit funnel" },
  reports: { env: "FEATURE_REPORTS", description: "Shareable reports" },
  analysisAi: { env: "FEATURE_ANALYSIS_AI", description: "AI sentiment for languages without a deterministic lexicon" },
} as const;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

export function resolveFlag(envDefault: boolean, globalValue?: boolean | null, orgOverride?: boolean | null): boolean {
  if (orgOverride !== undefined && orgOverride !== null) return orgOverride;
  if (globalValue !== undefined && globalValue !== null) return globalValue;
  return envDefault;
}

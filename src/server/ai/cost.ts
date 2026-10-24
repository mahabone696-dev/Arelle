export interface TokenPricing {
  inputCostPer1M: number;
  outputCostPer1M: number;
  requestCost?: number;
}

/** USD cost for one or more calls; rounded to 6 decimals to match DB precision. */
export function estimateCostUsd(usage: { inputTokens: number; outputTokens: number; requests?: number }, pricing: TokenPricing | null): number {
  if (!pricing) return 0;
  const cost = (usage.inputTokens * pricing.inputCostPer1M + usage.outputTokens * pricing.outputCostPer1M) / 1_000_000 + (usage.requests ?? 1) * (pricing.requestCost ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

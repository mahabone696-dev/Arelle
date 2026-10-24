import { db } from "@/server/db";
import { estimateCostUsd, type TokenPricing } from "@/server/ai/cost";
import type { StructuredUsage } from "@/server/ai/structured";
import { logger } from "@/lib/logger";

export const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10);

async function pricingFor(provider: string, model: string): Promise<TokenPricing | null> {
  const row = await db.aIModel.findFirst({
    where: { provider: { slug: provider }, OR: [{ modelId: model }, { modelId: { startsWith: model.replace(/-\d{4}-\d{2}-\d{2}$/, "") } }] },
    select: { inputCostPer1M: true, outputCostPer1M: true, requestCost: true },
  });
  if (!row) {
    logger.warn("ai.pricing.unknown_model", { provider, model });
    return null;
  }
  return { inputCostPer1M: Number(row.inputCostPer1M), outputCostPer1M: Number(row.outputCostPer1M), requestCost: Number(row.requestCost) };
}

/** Appends an AI_EXTRACTION usage record (with estimated cost) for onboarding generation. */
export async function recordAiUsage(organizationId: string, usage: StructuredUsage, referenceId: string): Promise<number> {
  const cost = estimateCostUsd({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, requests: usage.attempts }, await pricingFor(usage.provider, usage.model));
  await db.usageRecord.create({
    data: { organizationId, metric: "AI_EXTRACTION", quantity: usage.attempts, costUsd: cost, periodKey: utcDayKey(), providerSlug: usage.provider, referenceId },
  });
  logger.info("ai.usage", { organizationId, provider: usage.provider, model: usage.model, attempts: usage.attempts, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost, referenceId });
  return cost;
}

export async function recordCrawlUsage(organizationId: string, pages: number, referenceId: string): Promise<void> {
  await db.usageRecord.create({ data: { organizationId, metric: "CRAWL_PAGE", quantity: pages, periodKey: utcDayKey(), referenceId } });
}

/**
 * Pre-dispatch scan plan: prompt count × provider count = expected queries,
 * plus a conservative cost estimate. Pure apart from adapters' estimateCost.
 */
import type { AIAnswerProvider } from "@/server/providers/types";

export interface PlanPrompt {
  id: string;
  text: string;
  country: string;
  language: string;
}

export interface PlanProvider {
  providerId: string;
  slug: string;
  modelRowId: string;
  adapter: Pick<AIAnswerProvider, "estimateCost">;
}

export interface ScanPlan {
  promptCount: number;
  providerCount: number;
  expectedQueryCount: number;
  estimatedCost: number;
  perProvider: Array<{ providerId: string; slug: string; queries: number; estimatedCost: number }>;
}

export async function computeScanPlan(projectId: string, prompts: PlanPrompt[], providers: PlanProvider[]): Promise<ScanPlan> {
  const perProvider = [];
  for (const p of providers) {
    let cost = 0;
    for (const prompt of prompts) {
      cost += await p.adapter.estimateCost({ prompt: prompt.text, country: prompt.country, language: prompt.language, projectId, promptId: prompt.id });
    }
    perProvider.push({ providerId: p.providerId, slug: p.slug, queries: prompts.length, estimatedCost: round6(cost) });
  }
  return {
    promptCount: prompts.length,
    providerCount: providers.length,
    expectedQueryCount: prompts.length * providers.length,
    estimatedCost: round6(perProvider.reduce((a, b) => a + b.estimatedCost, 0)),
    perProvider,
  };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

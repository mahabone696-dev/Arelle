/**
 * Runtime query quota, checked immediately before every paid provider call
 * (including retries). Redis INCR is atomic across all worker processes, so
 * concurrent jobs can never overshoot a cap.
 */
import type { Redis } from "ioredis";
import { utcDayKey } from "./config";

export type QuotaScope = "GLOBAL" | "ORG" | "PROVIDER";

export interface QuotaRequest {
  organizationId: string;
  providerSlug: string;
  caps: { global: number; org: number; provider: number };
}

export interface QuotaGuard {
  /** Reserves one query; returns the exceeded scope, or null when allowed. */
  reserve(req: QuotaRequest): Promise<QuotaScope | null>;
}

// Increment all counters; if any exceeds its cap, roll back the increments and report which one.
const RESERVE_LUA = `
for i = 1, #KEYS do
  local v = redis.call('INCR', KEYS[i])
  if v == 1 then redis.call('EXPIRE', KEYS[i], ARGV[#KEYS + 1]) end
  if v > tonumber(ARGV[i]) then
    for j = 1, i do redis.call('DECR', KEYS[j]) end
    return i
  end
end
return 0`;

const SCOPES: QuotaScope[] = ["GLOBAL", "ORG", "PROVIDER"];

export function redisQuotaGuard(redis: Redis, now: () => Date = () => new Date()): QuotaGuard {
  return {
    async reserve(req) {
      const day = utcDayKey(now());
      const keys = [`quota:${day}:global`, `quota:${day}:org:${req.organizationId}`, `quota:${day}:provider:${req.providerSlug}`];
      const result = (await redis.eval(RESERVE_LUA, keys.length, ...keys, req.caps.global, req.caps.org, req.caps.provider, 2 * 86_400)) as number;
      return result === 0 ? null : SCOPES[result - 1]!;
    },
  };
}

/** Single-process guard for tests. */
export function memoryQuotaGuard(): QuotaGuard & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async reserve(req) {
      const keys: Array<[string, number]> = [["global", req.caps.global], [`org:${req.organizationId}`, req.caps.org], [`provider:${req.providerSlug}`, req.caps.provider]];
      for (let i = 0; i < keys.length; i++) {
        const [k, cap] = keys[i]!;
        const v = (counts.get(k) ?? 0) + 1;
        counts.set(k, v);
        if (v > cap) {
          for (let j = 0; j <= i; j++) counts.set(keys[j]![0], counts.get(keys[j]![0])! - 1);
          return SCOPES[i]!;
        }
      }
      return null;
    },
  };
}

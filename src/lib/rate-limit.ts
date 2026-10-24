/**
 * Fixed-window rate limiter behind an interface. The in-memory store is
 * per-process (fine for dev and as a first line of defence); a Redis-backed
 * store replaces it once Redis is introduced (Phase 3) for multi-instance
 * enforcement.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, windowMs: number) {
    const t = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      const fresh = { count: 1, resetAt: t + windowMs };
      this.buckets.set(key, fresh);
      if (this.buckets.size > 10_000) this.sweep(t);
      return fresh;
    }
    bucket.count += 1;
    return bucket;
  }

  private sweep(t: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= t) this.buckets.delete(k);
  }
}

let defaultStore: RateLimitStore = new MemoryRateLimitStore();

export function setRateLimitStore(store: RateLimitStore): void {
  defaultStore = store;
}

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  store: RateLimitStore = defaultStore,
): Promise<RateLimitResult> {
  const { count, resetAt } = await store.hit(key, windowMs);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}

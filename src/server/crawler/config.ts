/** Crawler limits. Env values are clamped to hard ceilings so misconfiguration can't create an unbounded crawler. */
const clamp = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), min), max) : fallback;
};

export interface CrawlLimits {
  maxPages: number;
  maxBytesPerResponse: number;
  requestTimeoutMs: number;
  totalBudgetMs: number;
  maxSitemapFetches: number;
  maxRedirects: number;
  concurrency: number;
  /** Delay between requests to the same site; robots crawl-delay raises it. */
  minDelayMs: number;
  /** robots crawl-delay above this → only the homepage is fetched. */
  maxHonoredCrawlDelayMs: number;
}

export function crawlLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): CrawlLimits {
  return {
    maxPages: clamp(env.CRAWLER_MAX_PAGES, 12, 1, 25),
    maxBytesPerResponse: clamp(env.CRAWLER_MAX_BYTES, 2_000_000, 50_000, 5_000_000),
    requestTimeoutMs: clamp(env.CRAWLER_TIMEOUT_MS, 10_000, 1_000, 20_000),
    totalBudgetMs: 60_000,
    maxSitemapFetches: 3,
    maxRedirects: 5,
    concurrency: 2,
    minDelayMs: 250,
    maxHonoredCrawlDelayMs: 5_000,
  };
}

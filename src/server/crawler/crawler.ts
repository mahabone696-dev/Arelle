/**
 * Bounded same-site crawl used by onboarding: robots.txt → homepage →
 * sitemap → a small set of high-signal pages. Never follows links beyond
 * depth 1 and never leaves the submitted site.
 */
import { logger } from "@/lib/logger";
import { crawlLimitsFromEnv, type CrawlLimits } from "./config";
import { CrawlError, type CrawlErrorCode } from "./errors";
import { extractPage, type ExtractedPage } from "./extract";
import { selectPages } from "./page-selection";
import { MISSING_ROBOTS, parseRobots, UNAVAILABLE_ROBOTS, type RobotsPolicy, type RobotsStatus } from "./robots";
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from "./safe-fetch";
import { parseSitemap } from "./sitemap";
import { assertCrawlableUrl, isSameSite, siteOf } from "./url-policy";

const HTML_TYPES = ["text/html", "application/xhtml+xml"] as const;

export interface CrawlFailure {
  url: string;
  code: CrawlErrorCode;
  message: string;
}

export interface CrawlResult {
  requestedUrl: string;
  site: string;
  homepageUrl: string;
  robots: { status: RobotsStatus; crawlDelaySeconds?: number; homepageOnly: boolean };
  sitemapUrlCount: number;
  pages: ExtractedPage[];
  failures: CrawlFailure[];
  stats: { requests: number; bytes: number; durationMs: number };
}

export interface CrawlDeps {
  fetch: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: CrawlDeps = {
  fetch: safeFetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

export interface CrawlOptions {
  /** ISO-639-1 language of the project; pages in other languages are deprioritized. */
  language?: string;
}

export async function crawlSite(
  input: string,
  limits: CrawlLimits = crawlLimitsFromEnv(),
  deps: CrawlDeps = defaultDeps,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const started = deps.now();
  const log = logger.child({ component: "crawler" });
  const start = assertCrawlableUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  const failures: CrawlFailure[] = [];
  const stats = { requests: 0, bytes: 0, durationMs: 0 };
  const overBudget = () => deps.now() - started > limits.totalBudgetMs;

  const get = async (url: string, opts: Partial<SafeFetchOptions> = {}) => {
    stats.requests++;
    const res = await deps.fetch(url, {
      maxBytes: limits.maxBytesPerResponse,
      timeoutMs: limits.requestTimeoutMs,
      maxRedirects: limits.maxRedirects,
      ...opts,
    });
    stats.bytes += res.bytes;
    return res;
  };

  const loadRobots = async (origin: string): Promise<RobotsPolicy> => {
    const robotsUrl = `${origin}/robots.txt`;
    try {
      const res = await get(robotsUrl, { accept: "text/plain", maxBytes: 512 * 1024, timeoutMs: Math.min(limits.requestTimeoutMs, 5_000) });
      if (res.status >= 200 && res.status < 300) return parseRobots(robotsUrl, res.body);
      if (res.status >= 400 && res.status < 500) return MISSING_ROBOTS;
      return UNAVAILABLE_ROBOTS;
    } catch (error) {
      if (error instanceof CrawlError && (error.code === "BLOCKED_ADDRESS" || error.code === "DNS_FAILED")) throw error;
      return UNAVAILABLE_ROBOTS;
    }
  };

  // 1. robots.txt for the submitted host, then the homepage (with HTTPS → HTTP fallback on connection failure).
  const homeCandidate = new URL("/", start);
  let robots = await loadRobots(homeCandidate.origin);
  if (robots.status === "PARSED" && !robots.isAllowed(homeCandidate.href)) {
    throw new CrawlError("ROBOTS_DISALLOWED", "This website's robots.txt does not allow us to analyze it.", homeCandidate.href);
  }

  let home: SafeFetchResult;
  try {
    home = await get(homeCandidate.href, { contentTypes: HTML_TYPES });
  } catch (error) {
    if (error instanceof CrawlError && error.code === "NETWORK" && homeCandidate.protocol === "https:") {
      homeCandidate.protocol = "http:";
      home = await get(homeCandidate.href, { contentTypes: HTML_TYPES });
    } else {
      throw error;
    }
  }
  if (home.status >= 400) throw new CrawlError("BAD_STATUS", `The website returned an error (HTTP ${home.status}).`, home.finalUrl);

  const finalHome = new URL(home.finalUrl);
  const site = siteOf(finalHome.hostname);
  if (finalHome.origin !== homeCandidate.origin) robots = await loadRobots(finalHome.origin);

  const pages: ExtractedPage[] = [extractPage(home.body, home.finalUrl)];
  const crawlDelayMs = (robots.crawlDelaySeconds ?? 0) * 1000;
  const homepageOnly = robots.status === "UNAVAILABLE" || crawlDelayMs > limits.maxHonoredCrawlDelayMs || limits.maxPages <= 1;
  const delay = Math.max(limits.minDelayMs, crawlDelayMs);

  // 2. Sitemap discovery (only same-site sitemap URLs; .gz is skipped).
  const sitemapUrls: string[] = [];
  if (!homepageOnly) {
    const queue = robots.sitemaps.length ? [...robots.sitemaps] : [`${finalHome.origin}/sitemap.xml`];
    let fetched = 0;
    while (queue.length && fetched < limits.maxSitemapFetches && !overBudget()) {
      const next = queue.shift()!;
      let url: URL;
      try {
        url = assertCrawlableUrl(next);
      } catch {
        continue;
      }
      if (!isSameSite(url, site) || url.pathname.endsWith(".gz")) continue;
      fetched++;
      try {
        await deps.sleep(delay);
        const res = await get(url.href, { accept: "application/xml,text/xml;q=0.9,*/*;q=0.1" });
        if (res.status >= 400) continue;
        const parsed = parseSitemap(res.body);
        sitemapUrls.push(...parsed.urls);
        queue.push(...parsed.sitemaps);
      } catch (error) {
        if (error instanceof CrawlError) failures.push({ url: url.href, code: error.code, message: error.message });
      }
    }
  }

  // 3. Fetch selected pages (depth 1) with bounded concurrency and politeness delay.
  if (!homepageOnly) {
    const candidates = [...pages[0]!.links, ...sitemapUrls];
    const targets = selectPages(candidates, site, home.finalUrl, limits.maxPages - 1, options.language).filter((u) => robots.isAllowed(u));
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length && !overBudget()) {
        const url = targets[cursor++]!;
        await deps.sleep(delay);
        try {
          const res = await get(url, { contentTypes: HTML_TYPES });
          const final = new URL(res.finalUrl);
          if (res.status >= 400) {
            failures.push({ url, code: "BAD_STATUS", message: `HTTP ${res.status}` });
          } else if (!isSameSite(final, site)) {
            failures.push({ url, code: "BLOCKED_ADDRESS", message: "Redirected off-site" });
          } else {
            pages.push(extractPage(res.body, res.finalUrl));
          }
        } catch (error) {
          if (error instanceof CrawlError) failures.push({ url, code: error.code, message: error.message });
          else throw error;
        }
      }
    };
    // A robots crawl-delay means one request per interval, so no parallelism.
    const concurrency = crawlDelayMs > 0 ? 1 : limits.concurrency;
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  stats.durationMs = deps.now() - started;
  log.info("crawl.completed", { site, pages: pages.length, failures: failures.length, requests: stats.requests, bytes: stats.bytes, durationMs: stats.durationMs, robots: robots.status });
  return {
    requestedUrl: start.href,
    site,
    homepageUrl: home.finalUrl,
    robots: { status: robots.status, crawlDelaySeconds: robots.crawlDelaySeconds, homepageOnly },
    sitemapUrlCount: sitemapUrls.length,
    pages,
    failures,
    stats,
  };
}

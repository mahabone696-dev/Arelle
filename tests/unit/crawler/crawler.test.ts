import { describe, expect, it } from "vitest";
import { crawlSite, type CrawlDeps } from "@/server/crawler/crawler";
import type { CrawlLimits } from "@/server/crawler/config";
import { CrawlError } from "@/server/crawler/errors";
import type { SafeFetchOptions, SafeFetchResult } from "@/server/crawler/safe-fetch";

const limits: CrawlLimits = {
  maxPages: 4,
  maxBytesPerResponse: 100_000,
  requestTimeoutMs: 1000,
  totalBudgetMs: 10_000,
  maxSitemapFetches: 3,
  maxRedirects: 5,
  concurrency: 2,
  minDelayMs: 0,
  maxHonoredCrawlDelayMs: 5000,
};

type Route = { status?: number; body?: string; finalUrl?: string; contentType?: string } | Error;

function fakeSite(routes: Record<string, Route>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const deps: CrawlDeps = {
    async fetch(url: string, _opts: SafeFetchOptions): Promise<SafeFetchResult> {
      calls.push(url);
      const r = routes[url];
      if (r instanceof Error) throw r;
      if (!r) return { url, finalUrl: url, status: 404, contentType: "text/html", body: "", bytes: 0, redirects: [] };
      const body = r.body ?? "";
      return { url, finalUrl: r.finalUrl ?? url, status: r.status ?? 200, contentType: r.contentType ?? "text/html", body, bytes: body.length, redirects: [] };
    },
    sleep: async (ms) => void sleeps.push(ms),
    now: () => 0,
  };
  return { deps, calls, sleeps };
}

const page = (title: string, links: string[] = []) => `<title>${title}</title><main><p>${title} content</p>${links.map((l) => `<a href="${l}">x</a>`).join("")}</main>`;

describe("crawlSite", () => {
  it("crawls robots → homepage → sitemap → selected pages, respecting robots and the page limit", async () => {
    const { deps, calls } = fakeSite({
      "https://acme.com/robots.txt": { body: "User-agent: *\nDisallow: /secret\nSitemap: https://acme.com/sitemap.xml" },
      "https://acme.com/": { finalUrl: "https://acme.com/", body: page("Home", ["/about", "/secret/plan", "https://evil.com/about"]) },
      "https://acme.com/sitemap.xml": {
        body: `<urlset><url><loc>https://acme.com/pricing</loc></url><url><loc>https://acme.com/product</loc></url><url><loc>https://acme.com/features</loc></url><url><loc>https://acme.com/blog/a</loc></url></urlset>`,
      },
      "https://acme.com/about": { body: page("About") },
      "https://acme.com/pricing": { body: page("Pricing") },
      "https://acme.com/product": { body: page("Product") },
      "https://acme.com/features": { body: page("Features") },
    });
    const result = await crawlSite("acme.com", limits, deps);
    expect(result.site).toBe("acme.com");
    expect(result.pages).toHaveLength(4);
    expect(result.pages[0]!.title).toBe("Home");
    expect(calls).not.toContain("https://acme.com/secret/plan");
    expect(calls.some((c) => c.includes("evil.com"))).toBe(false);
    expect(result.sitemapUrlCount).toBe(4);
    expect(result.robots.status).toBe("PARSED");
  });

  it("refuses when robots disallows the homepage", async () => {
    const { deps } = fakeSite({ "https://acme.com/robots.txt": { body: "User-agent: ArelleBot\nDisallow: /" } });
    await expect(crawlSite("acme.com", limits, deps)).rejects.toMatchObject({ code: "ROBOTS_DISALLOWED" });
  });

  it("fetches only the homepage when robots.txt is unavailable (5xx)", async () => {
    const { deps, calls } = fakeSite({
      "https://acme.com/robots.txt": { status: 503 },
      "https://acme.com/": { body: page("Home", ["/about"]) },
      "https://acme.com/about": { body: page("About") },
    });
    const r = await crawlSite("acme.com", limits, deps);
    expect(r.robots.homepageOnly).toBe(true);
    expect(r.pages).toHaveLength(1);
    expect(calls).toEqual(["https://acme.com/robots.txt", "https://acme.com/"]);
  });

  it("honors crawl-delay and goes homepage-only when it is excessive", async () => {
    const site = {
      "https://acme.com/": { body: page("Home", ["/about"]) },
      "https://acme.com/about": { body: page("About") },
    };
    const polite = fakeSite({ ...site, "https://acme.com/robots.txt": { body: "User-agent: *\nCrawl-delay: 2" } });
    await crawlSite("acme.com", limits, polite.deps);
    expect(polite.sleeps.every((ms) => ms === 2000)).toBe(true);

    const slow = fakeSite({ ...site, "https://acme.com/robots.txt": { body: "User-agent: *\nCrawl-delay: 60" } });
    const r = await crawlSite("acme.com", limits, slow.deps);
    expect(r.robots.homepageOnly).toBe(true);
    expect(r.pages).toHaveLength(1);
  });

  it("records page failures without failing the crawl, and drops off-site redirects", async () => {
    const { deps } = fakeSite({
      "https://acme.com/robots.txt": { status: 404 },
      "https://acme.com/": { body: page("Home", ["/about", "/pricing"]) },
      "https://acme.com/about": new CrawlError("TIMEOUT", "slow"),
      "https://acme.com/pricing": { finalUrl: "https://other.com/pricing", body: page("Other") },
    });
    const r = await crawlSite("acme.com", limits, deps);
    expect(r.pages).toHaveLength(1);
    expect(r.failures.map((f) => f.code).sort()).toEqual(["BLOCKED_ADDRESS", "TIMEOUT"]);
  });

  it("uses the redirected homepage host as the site", async () => {
    const { deps } = fakeSite({
      "https://acme.io/robots.txt": { status: 404 },
      "https://acme.io/": { finalUrl: "https://www.acme.com/", body: page("Home") },
      "https://www.acme.com/robots.txt": { status: 404 },
    });
    const r = await crawlSite("https://acme.io", limits, deps);
    expect(r.site).toBe("acme.com");
    expect(r.homepageUrl).toBe("https://www.acme.com/");
  });

  it("fails clearly on blocked input and HTTP errors", async () => {
    const { deps } = fakeSite({ "https://acme.com/robots.txt": { status: 404 }, "https://acme.com/": { status: 500 } });
    await expect(crawlSite("http://10.0.0.1", limits, deps)).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    await expect(crawlSite("acme.com", limits, deps)).rejects.toMatchObject({ code: "BAD_STATUS" });
  });
});

import { describe, expect, it } from "vitest";
import { parseRobots } from "@/server/crawler/robots";
import { parseSitemap } from "@/server/crawler/sitemap";
import { extractPage } from "@/server/crawler/extract";
import { scoreUrl, selectPages, splitLocale } from "@/server/crawler/page-selection";

describe("robots", () => {
  const robots = parseRobots(
    "https://example.com/robots.txt",
    "User-agent: *\nDisallow: /private\n\nUser-agent: ArelleBot\nDisallow: /no-arelle\nCrawl-delay: 2\n\nSitemap: https://example.com/sm.xml\n",
  );
  it("applies our agent's group", () => {
    expect(robots.isAllowed("https://example.com/pricing")).toBe(true);
    expect(robots.isAllowed("https://example.com/no-arelle/x")).toBe(false);
    expect(robots.crawlDelaySeconds).toBe(2);
    expect(robots.sitemaps).toEqual(["https://example.com/sm.xml"]);
  });
  it("falls back to the * group", () => {
    const r = parseRobots("https://a.com/robots.txt", "User-agent: *\nDisallow: /\n");
    expect(r.isAllowed("https://a.com/")).toBe(false);
  });
});

describe("sitemap", () => {
  it("parses urlsets and sitemap indexes", () => {
    const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/</loc></url><url><loc> https://example.com/pricing </loc></url><url><loc>javascript:x</loc></url></urlset>`;
    expect(parseSitemap(urlset)).toEqual({ urls: ["https://example.com/", "https://example.com/pricing"], sitemaps: [] });
    const index = `<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(index).sitemaps).toEqual(["https://example.com/a.xml"]);
  });
  it("does not expand entities and survives garbage", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><urlset><url><loc>https://e.com/&lol2;</loc></url></urlset>`;
    const r = parseSitemap(bomb);
    expect(r.urls.join("")).not.toContain("lollol");
    expect(parseSitemap("<<<not xml")).toEqual({ urls: [], sitemaps: [] });
  });
});

describe("extractPage", () => {
  const html = `<!doctype html><html lang="en-GB"><head>
    <title> Acme CRM — Sales software for startups </title>
    <meta name="description" content="Acme helps startups close deals.">
    <meta property="og:site_name" content="Acme">
    <link rel="canonical" href="/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Acme Inc","sameAs":["https://twitter.com/acme"]},{"@type":"SoftwareApplication","name":"Acme CRM"}]}</script>
    <script>var secret = "do not include";</script>
    </head><body><nav><a href="/login">Log in</a></nav>
    <main><h1>Close more deals</h1><h2>Pipeline management</h2><p>Track every lead from first touch to signed contract.</p>
    <a href="/pricing#plans">Pricing</a><a href="https://other.com/x">Out</a><a href="mailto:a@b.c">Mail</a></main>
    <footer>© Acme</footer></body></html>`;
  const page = extractPage(html, "https://acme.com/");

  it("extracts metadata, headings and JSON-LD", () => {
    expect(page.title).toBe("Acme CRM — Sales software for startups");
    expect(page.description).toBe("Acme helps startups close deals.");
    expect(page.lang).toBe("en-GB");
    expect(page.siteName).toBe("Acme");
    expect(page.canonical).toBe("https://acme.com/");
    expect(page.headings.h1).toEqual(["Close more deals"]);
    expect(page.jsonLd.map((e) => [e.type, e.name])).toEqual([["Organization", "Acme Inc"], ["SoftwareApplication", "Acme CRM"]]);
  });

  it("extracts main text without scripts or navigation", () => {
    expect(page.text).toContain("Track every lead");
    expect(page.text).not.toContain("do not include");
    expect(page.text).not.toContain("Log in");
    expect(page.text).not.toContain("© Acme");
  });

  it("resolves links and drops fragments and non-http schemes", () => {
    expect(page.links).toContain("https://acme.com/pricing");
    expect(page.links).toContain("https://other.com/x");
    expect(page.links.some((l) => l.startsWith("mailto"))).toBe(false);
  });
});

describe("page selection", () => {
  it("prefers about/product/pricing pages and excludes junk", () => {
    const u = (p: string) => new URL(`https://acme.com${p}`);
    expect(scoreUrl(u("/about"))).toBeGreaterThan(scoreUrl(u("/blog/2024/01/some-post")));
    expect(scoreUrl(u("/privacy-policy"))).toBe(-1);
    expect(scoreUrl(u("/login"))).toBe(-1);
    expect(scoreUrl(u("/whitepaper.pdf"))).toBe(-1);
  });

  it("selects same-site pages only, deduplicated, up to the limit", () => {
    const picked = selectPages(
      [
        "https://acme.com/pricing",
        "https://www.acme.com/pricing/",
        "https://acme.com/about",
        "https://acme.com/blog/post-1",
        "https://evil.com/about",
        "https://acme.com.evil.com/product",
        "https://shop.acme.com/products",
        "https://acme.com/terms",
        "https://acme.com/",
      ],
      "acme.com",
      "https://acme.com/",
      3,
    );
    expect(picked).toHaveLength(3);
    expect(picked).toEqual(expect.arrayContaining(["https://acme.com/about", "https://acme.com/pricing", "https://shop.acme.com/products"]));
  });
});

describe("page selection: language and diversity", () => {
  it("prefers the project language and skips translations of the same page", () => {
    const picked = selectPages(
      ["https://p.com/cs/about", "https://p.com/en/about", "https://p.com/about", "https://p.com/de/pricing", "https://p.com/en/pricing"],
      "p.com",
      "https://p.com/",
      5,
      "en",
    );
    expect(picked).toContain("https://p.com/en/pricing");
    expect(picked.filter((u) => u.endsWith("/about"))).toHaveLength(1);
    expect(picked.some((u) => u.includes("/cs/") || u.includes("/de/"))).toBe(false);
  });

  it("caps pages per section", () => {
    const many = Array.from({ length: 8 }, (_, i) => `https://n.com/product/use-case-${i}`);
    const picked = selectPages([...many, "https://n.com/about", "https://n.com/pricing"], "n.com", "https://n.com/", 10, "en");
    expect(picked.filter((u) => u.includes("/product/"))).toHaveLength(3);
    expect(picked).toEqual(expect.arrayContaining(["https://n.com/about", "https://n.com/pricing"]));
  });

  it("does not mistake non-locale two-letter paths for locales", () => {
    expect(splitLocale("/ai/assistant")).toEqual({ rest: "/ai/assistant" });
    expect(splitLocale("/pt-br/precos")).toEqual({ locale: "pt", rest: "/precos" });
  });
});

describe("page selection: scoring", () => {
  it("does not stack keyword boosts in favour of deep pages", () => {
    const u = (p: string) => new URL(`https://n.com${p}`);
    expect(scoreUrl(u("/product"), "en")).toBeGreaterThan(scoreUrl(u("/product/ai/use-cases/triage"), "en"));
  });
  it("treats a locale root as a duplicate of the homepage", () => {
    expect(selectPages(["https://n.com/en-GB", "https://n.com/about"], "n.com", "https://n.com/", 5, "en")).toEqual(["https://n.com/about"]);
  });
});

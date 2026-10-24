import { describe, expect, it } from "vitest";
import { assertCrawlableUrl, isSameSite, siteOf } from "@/server/crawler/url-policy";
import { CrawlError } from "@/server/crawler/errors";

describe("assertCrawlableUrl", () => {
  it("accepts public http(s) URLs and strips fragments", () => {
    expect(assertCrawlableUrl("https://www.example.com/a#b").href).toBe("https://www.example.com/a");
    expect(assertCrawlableUrl("http://example.com:80/").href).toBe("http://example.com/");
  });

  it.each([
    "ftp://example.com/",
    "file:///etc/passwd",
    "gopher://example.com/",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://017700000001/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata/",
    "http://user:pw@example.com/",
    "http://example.com:22/",
    "http://service.internal/",
    "http://printer.local/",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertCrawlableUrl(url)).toThrow(CrawlError);
  });
});

describe("same-site", () => {
  it("treats www and subdomains as the same site, but not lookalikes", () => {
    const site = siteOf("www.example.com");
    expect(site).toBe("example.com");
    expect(isSameSite(new URL("https://example.com/x"), site)).toBe(true);
    expect(isSameSite(new URL("https://shop.example.com/x"), site)).toBe(true);
    expect(isSameSite(new URL("https://example.com.evil.io/"), site)).toBe(false);
    expect(isSameSite(new URL("https://notexample.com/"), site)).toBe(false);
  });
});

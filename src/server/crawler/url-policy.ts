/**
 * URL-level SSRF policy, applied to the initial URL and to every redirect
 * target. Hostname resolution is checked separately at connect time.
 */
import { normalizeDomain } from "@/lib/domain";
import { CrawlError } from "./errors";

const BLOCKED_HOSTS = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

export function assertCrawlableUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CrawlError("INVALID_URL", "That address isn't a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CrawlError("INVALID_URL", "Only http and https URLs can be analyzed.", url.href);
  }
  if (url.username || url.password) throw new CrawlError("INVALID_URL", "URLs with credentials are not allowed.", url.href);
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new CrawlError("BLOCKED_ADDRESS", "Custom ports are not allowed.", url.href);
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) throw new CrawlError("BLOCKED_ADDRESS", "That address is not allowed.", url.href);
  // Reuses the domain syntax rules: no IP literals, localhost, or internal suffixes.
  const domain = normalizeDomain(url.href);
  if (!domain.ok) throw new CrawlError("BLOCKED_ADDRESS", domain.reason, url.href);
  url.hash = "";
  return url;
}

/** "Same site" = the root domain or any of its subdomains (www., shop., ...). */
export function siteOf(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function isSameSite(url: URL, site: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === site || host.endsWith(`.${site}`);
}

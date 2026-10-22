/**
 * Domain normalization for user-entered websites ("https://www.Example.com/pricing"
 * → "example.com"). This is a syntactic check only; network-level SSRF
 * protection (DNS resolution, private ranges, redirects) lives in the crawler.
 */
export type DomainResult = { ok: true; domain: string } | { ok: false; reason: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".test", ".invalid", ".example"];

export function normalizeDomain(input: string): DomainResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Enter a website address." };
  if (trimmed.length > 2048) return { ok: false, reason: "That address is too long." };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "That doesn't look like a valid website address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https websites are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Addresses with credentials are not allowed." };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: "Custom ports are not supported." };
  }

  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);

  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) {
    return { ok: false, reason: "Enter a domain name, not an IP address." };
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "Internal or reserved domains are not allowed." };
  }
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    return { ok: false, reason: "That doesn't look like a valid domain." };
  }
  const tld = labels[labels.length - 1]!;
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) {
    return { ok: false, reason: "That doesn't look like a valid domain." };
  }
  if (host.length > 253) return { ok: false, reason: "That domain is too long." };

  return { ok: true, domain: host };
}

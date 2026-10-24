/**
 * Citation normalization. Sources come from provider annotations first (they
 * carry the engine's own ordering), then from links in the answer text.
 * URLs are canonicalized (tracking params, fragments, www, trailing slash)
 * and grouped by registrable domain using the Public Suffix List.
 */
import { getDomain } from "tldts";

export type CitationOwner = "PRIMARY" | "COMPETITOR" | "THIRD_PARTY";

export interface RawCitation {
  url: string;
  title?: string;
}

export interface NormalizedCitation {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string | null;
  position: number;
  ownerType: CitationOwner;
  competitorId: string | null;
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|gbraid|wbraid|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|hsa_[a-z]+|igshid|ref|ref_src|ref_url|referrer|source|si|spm|trk|cmpid|campaign|_ga|_gl|oly_[a-z]+|vero_[a-z]+)$/i;

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return getDomain(host, { allowPrivateDomains: true }) ?? host.replace(/^www\./, "");
}

export function normalizeCitationUrl(raw: string): { url: string; normalizedUrl: string; domain: string } | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  u.search = kept.length ? new URLSearchParams(kept).toString() : "";
  const params = [...kept].sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "";
  const port = u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) ? `:${u.port}` : "";
  // Scheme is dropped from the canonical form: http/https variants are the same source.
  const normalizedUrl = `${host}${port}${path}${query}`;
  return { url: u.href, normalizedUrl, domain: registrableDomain(host) };
}

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(?<![\w(\]/])https?:\/\/[^\s<>"')\]]+/g;

export function extractTextLinks(rawText: string): RawCitation[] {
  const out: RawCitation[] = [];
  for (const m of rawText.matchAll(MD_LINK)) out.push({ url: m[2]!, title: m[1] || undefined });
  const withoutMd = rawText.replace(MD_LINK, " ");
  for (const m of withoutMd.matchAll(BARE_URL)) out.push({ url: m[0].replace(/[.,;:!?]+$/, "") });
  return out;
}

export interface OwnerLookup {
  primaryDomain: string | null;
  competitorDomains: Array<{ competitorId: string; domain: string }>;
}

export function normalizeCitations(providerCitations: RawCitation[], rawText: string, owners: OwnerLookup): NormalizedCitation[] {
  const primary = owners.primaryDomain ? registrableDomain(owners.primaryDomain) : null;
  const competitors = owners.competitorDomains.map((c) => ({ ...c, domain: registrableDomain(c.domain) }));
  const seen = new Set<string>();
  const out: NormalizedCitation[] = [];
  for (const c of [...providerCitations, ...extractTextLinks(rawText)]) {
    const n = normalizeCitationUrl(c.url);
    if (!n || seen.has(n.normalizedUrl)) continue;
    seen.add(n.normalizedUrl);
    const comp = competitors.find((x) => x.domain === n.domain);
    out.push({
      ...n,
      title: c.title?.trim() || null,
      position: out.length + 1,
      ownerType: primary && n.domain === primary ? "PRIMARY" : comp ? "COMPETITOR" : "THIRD_PARTY",
      competitorId: primary && n.domain === primary ? null : (comp?.competitorId ?? null),
    });
  }
  return out;
}

/**
 * SSRF-safe HTTP GET.
 *
 * - Every URL (initial and each redirect hop) passes assertCrawlableUrl().
 * - DNS resolution happens inside the connection's own lookup hook and every
 *   resolved address must satisfy the IP policy. Because the socket connects
 *   to the address we validated, DNS rebinding between check and use is not
 *   possible.
 * - Redirects are followed manually (max N) so each hop is re-validated.
 * - Bodies are streamed and aborted past maxBytes; the whole request,
 *   including the body, is bounded by a timeout.
 * - Response decompression is never requested (no gzip bombs).
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, request, type Dispatcher } from "undici";
import { CrawlError } from "./errors";
import { isPublicAddress, type IpPolicy } from "./ip-policy";
import { assertCrawlableUrl } from "./url-policy";

export const CRAWLER_USER_AGENT = "ArelleBot/0.1 (+https://arelle.ai/bot; AI visibility analysis)";

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  accept?: string;
  /** Allowed content types (prefix match on the media type). */
  contentTypes?: readonly string[];
  /** Test seam: defaults to the public-address policy. */
  ipPolicy?: IpPolicy;
  /** Test seam: replaces the URL policy (e.g. to allow a local test server). Ignored unless NODE_ENV=test. */
  urlPolicyForTests?: (url: string | URL) => URL;
}

export interface SafeFetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  redirects: string[];
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

export function createGuardedLookup(policy: IpPolicy): LookupFunction {
  return ((hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true, family: options?.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = addresses as LookupAddress[];
      // Reject the host if ANY record is non-public: mixed answers are a rebinding signal.
      if (list.length === 0 || list.some((a) => !policy(a.address))) {
        const blocked = Object.assign(new Error(`Blocked address for ${hostname}`), { code: "EBLOCKEDADDRESS" });
        return callback(blocked, []);
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as LookupFunction;
}

/**
 * Connector that enforces the IP policy for IP-literal hosts too: sockets
 * skip DNS lookup for literals, so the lookup hook alone would not see them.
 */
function guardedConnector(policy: IpPolicy): buildConnector.connector {
  const base = buildConnector({ lookup: createGuardedLookup(policy), timeout: 5_000 });
  return (options, callback) => {
    const host = options.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !policy(host)) {
      callback(Object.assign(new Error("Blocked address"), { code: "EBLOCKEDADDRESS" }), null);
      return;
    }
    base(options, callback);
  };
}

const agents = new WeakMap<IpPolicy, Agent>();
function agentFor(policy: IpPolicy): Agent {
  let agent = agents.get(policy);
  if (!agent) {
    agent = new Agent({
      connect: guardedConnector(policy),
      connections: 4,
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    agents.set(policy, agent);
  }
  return agent;
}

function mapError(error: unknown, url: string): CrawlError {
  if (error instanceof CrawlError) return error;
  const e = error as { code?: string; name?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code;
  if (code === "EBLOCKEDADDRESS") return new CrawlError("BLOCKED_ADDRESS", "That website resolves to a private or reserved network address.", url);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new CrawlError("DNS_FAILED", "We couldn't find that website. Check the address.", url);
  if (e.name === "AbortError" || e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return new CrawlError("TIMEOUT", "The website took too long to respond.", url);
  }
  return new CrawlError("NETWORK", "We couldn't connect to that website.", url);
}

/** Abort a response body we won't read; the listener prevents an unhandled AbortError. */
function discard(body: Dispatcher.ResponseData["body"]): void {
  body.on("error", () => {});
  body.destroy();
}

async function readLimited(body: Dispatcher.ResponseData["body"], maxBytes: number, url: string): Promise<{ text: string; bytes: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    if (bytes > maxBytes) {
      discard(body);
      throw new CrawlError("TOO_LARGE", "The page is larger than the allowed size.", url);
    }
    chunks.push(buf);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

export async function safeFetch(input: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const policy = options.ipPolicy ?? isPublicAddress;
  const dispatcher = agentFor(policy);
  const signal = AbortSignal.timeout(options.timeoutMs);
  const redirects: string[] = [];
  const urlPolicy = process.env.NODE_ENV === "test" && options.urlPolicyForTests ? options.urlPolicyForTests : assertCrawlableUrl;
  let current = urlPolicy(input);

  try {
    for (let hop = 0; ; hop++) {
      const res = await request(current, {
        method: "GET",
        dispatcher,
        signal,
        headers: {
          "user-agent": CRAWLER_USER_AGENT,
          accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
      });

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        discard(res.body);
        if (hop >= maxRedirects) throw new CrawlError("TOO_MANY_REDIRECTS", "The website redirected too many times.", current.href);
        const location = Array.isArray(res.headers.location) ? res.headers.location[0]! : res.headers.location;
        const next = new URL(location, current);
        current = urlPolicy(next);
        redirects.push(current.href);
        continue;
      }

      const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
      const encoding = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity" && encoding !== "") {
        discard(res.body);
        throw new CrawlError("UNSUPPORTED_CONTENT", "The website returned compressed content we don't accept.", current.href);
      }
      const declaredLength = Number(res.headers["content-length"] ?? 0);
      if (declaredLength > options.maxBytes) {
        discard(res.body);
        throw new CrawlError("TOO_LARGE", "The page is larger than the allowed size.", current.href);
      }
      if (options.contentTypes && res.statusCode < 400 && !options.contentTypes.some((t) => contentType.startsWith(t))) {
        discard(res.body);
        throw new CrawlError("UNSUPPORTED_CONTENT", "The URL did not return a web page.", current.href);
      }
      const { text, bytes } = await readLimited(res.body, options.maxBytes, current.href);
      return { url: input, finalUrl: current.href, status: res.statusCode, contentType, body: text, bytes, redirects };
    }
  } catch (error) {
    throw mapError(error, current.href);
  }
}

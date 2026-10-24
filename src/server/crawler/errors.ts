export type CrawlErrorCode =
  | "INVALID_URL"
  | "BLOCKED_ADDRESS"
  | "DNS_FAILED"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "TOO_MANY_REDIRECTS"
  | "BAD_STATUS"
  | "UNSUPPORTED_CONTENT"
  | "ROBOTS_DISALLOWED"
  | "NETWORK";

/** Message is safe to show to the user; it never includes resolved IPs. */
export class CrawlError extends Error {
  constructor(
    readonly code: CrawlErrorCode,
    message: string,
    readonly url?: string,
  ) {
    super(message);
    this.name = "CrawlError";
  }
}

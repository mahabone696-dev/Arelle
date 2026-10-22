/**
 * Transparent provider failure. `retryable` decides whether the scan job is
 * retried; the code is stored on the ScanJob so users and admins can see
 * exactly why an engine produced no answer.
 */
export type ProviderErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_IMPLEMENTED"
  | "AUTH"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "BAD_REQUEST"
  | "CONTENT_FILTERED"
  | "EMPTY_RESPONSE"
  | "UNKNOWN";

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["RATE_LIMITED", "TIMEOUT", "UNAVAILABLE", "EMPTY_RESPONSE", "UNKNOWN"]);

export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = RETRYABLE.has(code);
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

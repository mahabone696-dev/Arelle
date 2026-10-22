/**
 * Provider-agnostic contract for structured (JSON) generation used by
 * onboarding analysis. Answer collection for scans uses a separate
 * AIAnswerProvider interface (Phase 3) — the two are intentionally distinct.
 */
export interface LLMRequest {
  system: string;
  user: string;
  schemaName: string;
  /** Strict JSON Schema derived from the Zod schema. */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  /** True when the provider stopped early (e.g. token limit) — output is likely truncated. */
  incomplete?: boolean;
}

export interface StructuredLLMClient {
  readonly provider: string;
  readonly model: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export type LLMErrorKind = "TRANSIENT" | "FATAL";

/** Raised by clients. TRANSIENT (rate limit, 5xx, timeout) may be retried; FATAL (auth, bad request) may not. */
export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

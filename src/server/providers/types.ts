/**
 * Answer-provider contract. Scan business logic talks only to this
 * interface; each AI engine has its own adapter. Adapters never substitute
 * another engine's answer — they return a ProviderError instead.
 */
export interface AIQueryInput {
  prompt: string;
  /** ISO-3166-1 alpha-2, e.g. "US". */
  country: string;
  /** ISO-639-1, e.g. "en". */
  language: string;
  projectId: string;
  promptId: string;
}

export interface AIQueryCitation {
  url: string;
  title?: string;
  /** 1-based order of first appearance in the answer. */
  position: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface AIQueryResult {
  rawText: string;
  normalizedText: string;
  citations: AIQueryCitation[];
  /** Model identifier as reported by the provider. */
  model: string;
  latencyMs: number;
  tokenUsage: TokenUsage;
  /** USD, from actual usage. */
  estimatedCost: number;
  /** Provider-specific details (response id, tool calls, truncation...). Never secrets. */
  metadata: Record<string, unknown>;
}

export interface ProviderCapabilities {
  /** Answers include source URLs. */
  citations: boolean;
  /** Answers are grounded in live web search. */
  webSearch: boolean;
  /** Supports approximate user location (country) for localized answers. */
  location: boolean;
}

export interface AIAnswerProvider {
  /** Stable slug matching AIProvider.slug, e.g. "openai". */
  readonly providerName: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  query(input: AIQueryInput): Promise<AIQueryResult>;
  healthCheck(): Promise<boolean>;
  /** Conservative USD estimate for one query, used for pre-dispatch cost checks. */
  estimateCost(input: AIQueryInput): Promise<number>;
}

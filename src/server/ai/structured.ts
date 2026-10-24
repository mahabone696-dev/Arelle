/**
 * Validated structured generation with safe retries.
 *
 * Attempt loop (bounded by maxAttempts, default 3):
 *   - malformed JSON, schema violations, or truncated output → retry with a
 *     repair note listing the validation issues (never the raw website data);
 *   - transient provider errors → retry after exponential backoff;
 *   - fatal provider errors → stop immediately.
 * Every failed attempt is logged with the schema name and a summary of issues.
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { toStrictJsonSchema } from "./json-schema";
import { LLMError, type StructuredLLMClient } from "./types";

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  schemaName: string;
  system: string;
  user: string;
  maxOutputTokens?: number;
}

export interface StructuredUsage {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  provider: string;
}

export interface StructuredResult<T> {
  data: T;
  usage: StructuredUsage;
}

export type StructuredFailure = "INVALID_OUTPUT" | "PROVIDER_ERROR";

export class StructuredOutputError extends Error {
  constructor(
    readonly failure: StructuredFailure,
    message: string,
    readonly usage: StructuredUsage,
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface StructuredOptions {
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export function summarizeIssues(error: z.ZodError, max = 8): string[] {
  return error.issues.slice(0, max).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Tolerates code fences some models add despite JSON mode. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}

export async function generateStructured<S extends z.ZodType>(
  client: StructuredLLMClient,
  request: StructuredRequest<S>,
  options: StructuredOptions = {},
): Promise<StructuredResult<z.infer<S>>> {
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 5);
  const backoff = options.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const jsonSchema = toStrictJsonSchema(request.schema);
  const log = logger.child({ component: "ai.structured", schema: request.schemaName, provider: client.provider, model: client.model });
  const usage: StructuredUsage = { attempts: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, model: client.model, provider: client.provider };

  let repairNote = "";
  let lastProblem = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    usage.attempts = attempt;
    let text: string;
    try {
      const res = await client.complete({
        system: request.system,
        user: repairNote ? `${request.user}\n\n${repairNote}` : request.user,
        schemaName: request.schemaName,
        jsonSchema,
        maxOutputTokens: request.maxOutputTokens ?? 4000,
      });
      usage.inputTokens += res.inputTokens ?? 0;
      usage.outputTokens += res.outputTokens ?? 0;
      usage.latencyMs += res.latencyMs;
      usage.model = res.model;
      if (res.incomplete) {
        lastProblem = "response was truncated";
        log.warn("ai.structured_output.incomplete", { attempt });
        repairNote = "IMPORTANT: Your previous response was cut off. Respond more concisely with complete, valid JSON.";
        continue;
      }
      text = res.text;
    } catch (error) {
      if (error instanceof LLMError && error.kind === "TRANSIENT" && attempt < maxAttempts) {
        log.warn("ai.provider.transient_error", { attempt, status: error.status, message: error.message });
        await sleep(backoff(attempt));
        continue;
      }
      log.error("ai.provider.error", { attempt, status: error instanceof LLMError ? error.status : undefined, error });
      throw new StructuredOutputError("PROVIDER_ERROR", "The AI provider request failed.", usage);
    }

    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      lastProblem = "invalid JSON";
      log.warn("ai.structured_output.invalid_json", { attempt, length: text.length });
      repairNote = "IMPORTANT: Your previous response was not valid JSON. Return only a JSON object that matches the schema.";
      continue;
    }

    const parsed = request.schema.safeParse(json);
    if (parsed.success) {
      if (attempt > 1) log.info("ai.structured_output.recovered", { attempt });
      return { data: parsed.data, usage };
    }
    const issues = summarizeIssues(parsed.error);
    lastProblem = issues.join("; ");
    log.warn("ai.structured_output.schema_violation", { attempt, issues });
    repairNote = `IMPORTANT: Your previous response did not match the required schema. Fix these problems and return the complete JSON again:\n- ${issues.join("\n- ")}`;
  }

  log.error("ai.structured_output.failed", { attempts: usage.attempts, lastProblem });
  throw new StructuredOutputError("INVALID_OUTPUT", `AI output failed validation after ${usage.attempts} attempts: ${lastProblem}`, usage);
}

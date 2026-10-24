/**
 * Zod → JSON Schema in the subset accepted by OpenAI strict structured
 * outputs: every object closed (additionalProperties: false) with all
 * properties required, and only widely-supported keywords kept. The Zod
 * schema remains the source of truth and is always re-validated.
 */
import { z } from "zod";

const KEEP = new Set(["type", "properties", "required", "items", "enum", "const", "description", "additionalProperties", "anyOf", "minimum", "maximum", "minItems", "maxItems"]);

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (!KEEP.has(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, strictify(pv)])) : strictify(v);
  }
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strictify(z.toJSONSchema(schema, { target: "draft-7", io: "output", unrepresentable: "any" })) as Record<string, unknown>;
}

import { describe, expect, it } from "vitest";
import { redact } from "@/lib/logger";

describe("logger redaction", () => {
  it("redacts secret-looking keys, including nested ones", () => {
    const out = redact({ userId: "u1", apiKey: "sk-123", nested: { password: "p", authorization: "Bearer x", ok: 1 } });
    expect(out).toEqual({ userId: "u1", apiKey: "[REDACTED]", nested: { password: "[REDACTED]", authorization: "[REDACTED]", ok: 1 } });
  });

  it("serializes errors", () => {
    const out = redact({ error: new Error("boom") }) as { error: { message: string } };
    expect(out.error.message).toBe("boom");
  });
});

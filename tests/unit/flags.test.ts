import { describe, expect, it } from "vitest";
import { resolveFlag } from "@/server/flags/definitions";

describe("resolveFlag", () => {
  it("falls back to the env default when nothing is set in the DB", () => {
    expect(resolveFlag(true)).toBe(true);
    expect(resolveFlag(false, null, null)).toBe(false);
  });
  it("global DB value overrides env", () => {
    expect(resolveFlag(true, false)).toBe(false);
    expect(resolveFlag(false, true)).toBe(true);
  });
  it("org override wins over everything", () => {
    expect(resolveFlag(false, false, true)).toBe(true);
    expect(resolveFlag(true, true, false)).toBe(false);
  });
});

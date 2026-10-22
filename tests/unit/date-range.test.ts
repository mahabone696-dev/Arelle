import { describe, expect, it } from "vitest";
import { parseDateRange, resolveDateWindow } from "@/lib/date-range";

describe("date ranges", () => {
  it("parses known keys and falls back to 30d", () => {
    expect(parseDateRange("7d")).toBe("7d");
    expect(parseDateRange(["90d", "7d"])).toBe("90d");
    expect(parseDateRange("bogus")).toBe("30d");
    expect(parseDateRange(undefined)).toBe("30d");
  });

  it("computes a current and an equally long previous window", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    const w = resolveDateWindow("7d", now);
    expect(w.to.toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(w.from.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(w.previousFrom.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    expect(w.previousTo).toEqual(w.from);
  });
});

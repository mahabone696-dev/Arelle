import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore, rateLimit } from "@/lib/rate-limit";

describe("rateLimit", () => {
  it("allows up to the limit within a window, then blocks, then resets", async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);
    for (let i = 0; i < 3; i++) expect((await rateLimit("k", 3, 1000, store)).allowed).toBe(true);
    const blocked = await rateLimit("k", 3, 1000, store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    now += 1001;
    expect((await rateLimit("k", 3, 1000, store)).allowed).toBe(true);
  });

  it("isolates keys", async () => {
    const store = new MemoryRateLimitStore(() => 0);
    await rateLimit("a", 1, 1000, store);
    expect((await rateLimit("a", 1, 1000, store)).allowed).toBe(false);
    expect((await rateLimit("b", 1, 1000, store)).allowed).toBe(true);
  });
});

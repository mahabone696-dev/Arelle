import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

const APP = "https://app.example.com";

describe("safeRedirectPath", () => {
  it("allows relative paths and same-origin URLs", () => {
    expect(safeRedirectPath("/acme/p/1?range=7d", APP)).toBe("/acme/p/1?range=7d");
    expect(safeRedirectPath("https://app.example.com/acme/p/1", APP)).toBe("/acme/p/1");
  });
  it.each(["https://evil.com/", "//evil.com", "/\\evil.com", "javascript:alert(1)", "", null, 42, "https://app.example.com.evil.com/"])(
    "rejects %s",
    (target) => {
      expect(safeRedirectPath(target, APP)).toBe("/");
    },
  );
});

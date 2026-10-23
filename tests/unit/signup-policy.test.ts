import { describe, expect, it } from "vitest";
import { appOrigin, isSignupAllowed, parseSignupAllowlist } from "@/lib/signup-policy";

describe("sign-up allow-list", () => {
  const list = parseSignupAllowlist(" Owner@Example.com , @acme.io ,, ");
  it("parses entries", () => expect(list).toEqual(["owner@example.com", "@acme.io"]));
  it("allows listed emails and domains only", () => {
    expect(isSignupAllowed("OWNER@example.com", list)).toBe(true);
    expect(isSignupAllowed("anyone@acme.io", list)).toBe(true);
    expect(isSignupAllowed("x@notacme.io", list)).toBe(false);
    expect(isSignupAllowed("evil@acme.io.attacker.com", list)).toBe(false);
    expect(isSignupAllowed("other@example.com", list)).toBe(false);
  });
  it("is open when unset", () => expect(isSignupAllowed("a@b.c", parseSignupAllowlist(undefined))).toBe(true));
});

describe("appOrigin", () => {
  it("prefers AUTH_URL, then Render's external URL", () => {
    expect(appOrigin({ RENDER_EXTERNAL_URL: "https://arelle.onrender.com" })).toBe("https://arelle.onrender.com");
    expect(appOrigin({ AUTH_URL: "https://app.arelle.ai", RENDER_EXTERNAL_URL: "https://x.onrender.com" })).toBe("https://app.arelle.ai");
    expect(appOrigin({})).toBe("http://localhost:3000");
  });
});

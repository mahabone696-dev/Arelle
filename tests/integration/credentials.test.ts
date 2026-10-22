import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { authenticateCredentials, SIGN_IN_LIMITS } from "@/server/auth/credentials";
import { hashPassword } from "@/server/auth/password";

async function seedUser(email: string, password: string) {
  return db.user.create({ data: { email, passwordHash: await hashPassword(password) } });
}

describe("authenticateCredentials", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    await seedUser("cred@a.com", "the-right-password");
    expect(await authenticateCredentials({ email: "CRED@a.com", password: "the-right-password" }, "1.1.1.1")).toMatchObject({ ok: true });
    expect(await authenticateCredentials({ email: "cred@a.com", password: "nope" }, "1.1.1.1")).toEqual({ ok: false, reason: "bad_credentials" });
    expect(await authenticateCredentials({ email: "ghost@a.com", password: "nope" }, "1.1.1.1")).toEqual({ ok: false, reason: "bad_credentials" });
    expect(await authenticateCredentials({ email: "not-an-email" }, "1.1.1.1")).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("locks out an email after repeated failures, even with the right password, across IPs", async () => {
    await seedUser("target@a.com", "the-right-password");
    for (let i = 0; i < SIGN_IN_LIMITS.perEmail; i++) {
      await authenticateCredentials({ email: "target@a.com", password: `guess-${i}` }, `10.0.0.${i}`);
    }
    expect(await authenticateCredentials({ email: "target@a.com", password: "the-right-password" }, "10.9.9.9")).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });

  it("limits a single IP spraying many emails", async () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perIp; i++) {
      await authenticateCredentials({ email: `spray${i}@a.com`, password: "x" }, "203.0.113.7");
    }
    expect(await authenticateCredentials({ email: "fresh@a.com", password: "x" }, "203.0.113.7")).toEqual({ ok: false, reason: "rate_limited" });
  });
});

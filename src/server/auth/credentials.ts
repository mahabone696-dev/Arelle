/**
 * Email/password verification. Rate limiting lives here (not in the server
 * action) because Auth.js also exposes /api/auth/callback/credentials
 * directly; every path into credential checks must pass through this.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { hashPassword, verifyPassword } from "./password";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

const WINDOW_MS = 15 * 60 * 1000;
export const SIGN_IN_LIMITS = { perIp: 20, perEmail: 10 } as const;

// Verified against when the user doesn't exist, so response time doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword("dummy-password-for-timing"));

export type CredentialsResult =
  | { ok: true; user: { id: string; email: string; name: string | null; image: string | null } }
  | { ok: false; reason: "invalid_input" | "rate_limited" | "bad_credentials" };

export async function authenticateCredentials(raw: unknown, ip: string): Promise<CredentialsResult> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_input" };
  const { email, password } = parsed.data;

  const [byIp, byEmail] = await Promise.all([
    rateLimit(`sign-in:ip:${ip}`, SIGN_IN_LIMITS.perIp, WINDOW_MS),
    rateLimit(`sign-in:email:${email}`, SIGN_IN_LIMITS.perEmail, WINDOW_MS),
  ]);
  if (!byIp.allowed || !byEmail.allowed) {
    logger.warn("auth.sign_in_rate_limited", { ip, byIp: !byIp.allowed, byEmail: !byEmail.allowed });
    return { ok: false, reason: "rate_limited" };
  }

  const user = await db.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user?.passwordHash || !valid) {
    logger.info("auth.sign_in_failed", { reason: "bad_credentials" });
    return { ok: false, reason: "bad_credentials" };
  }
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, image: user.image } };
}

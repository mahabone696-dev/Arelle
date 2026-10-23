import { z } from "zod";
import { db } from "@/server/db";
import { getEnv } from "@/server/env";
import { ensurePersonalOrganization } from "@/server/organizations/service";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { AppError } from "@/lib/errors";
import { hashPassword } from "./password";
import { isSignupAllowed, parseSignupAllowlist } from "@/lib/signup-policy";

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(10, "Use at least 10 characters").max(200, "Password is too long"),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

/** Create a credentials user plus their first workspace. */
export async function registerUser(input: SignUpInput) {
  const data = signUpSchema.parse(input);
  if (!isSignupAllowed(data.email, parseSignupAllowlist(process.env.SIGNUP_ALLOWLIST))) {
    throw new AppError("FORBIDDEN", "Sign-up is invite-only on this deployment.");
  }
  const existing = await db.user.findUnique({ where: { email: data.email }, select: { id: true } });
  if (existing) throw new AppError("CONFLICT", "An account with this email already exists.");
  const user = await db.user.create({
    data: {
      name: data.name,
      email: data.email,
      passwordHash: await hashPassword(data.password),
      isPlatformAdmin: getEnv().PLATFORM_ADMIN_EMAILS.includes(data.email),
    },
    select: { id: true, name: true },
  });
  await ensurePersonalOrganization(user.id, user.name);
  await writeAuditLog({ actorId: user.id, action: "user.signed_up", entityType: "User", entityId: user.id });
  return user;
}

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { z } from "zod";
import { db } from "@/server/db";
import { ensurePersonalOrganization } from "@/server/organizations/service";
import { getEnv } from "@/server/env";
import { logger } from "@/lib/logger";
import { authConfig } from "./auth.config";
import { verifyPassword } from "./password";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

function buildProviders(): Provider[] {
  const providers: Provider[] = [
    Credentials({
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const user = await db.user.findUnique({ where: { email: parsed.data.email } });
        if (!user?.passwordHash) return null;
        const valid = await verifyPassword(parsed.data.password, user.passwordHash);
        if (!valid) {
          logger.info("auth.sign_in_failed", { reason: "bad_password" });
          return null;
        }
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ];
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google);
  if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) providers.push(GitHub);
  return providers;
}

export const enabledOAuthProviders = (): Array<"google" | "github"> => [
  ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? (["google"] as const) : []),
  ...(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET ? (["github"] as const) : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // The adapter types target the default @prisma/client output; our client is
  // generated to a custom path but exposes the same model delegates.
  adapter: PrismaAdapter(db as unknown as Parameters<typeof PrismaAdapter>[0]),
  providers: buildProviders(),
  events: {
    async createUser({ user }) {
      // OAuth sign-ups: grant admin by allow-list and create a workspace.
      if (!user.id) return;
      const admins = getEnv().PLATFORM_ADMIN_EMAILS;
      if (user.email && admins.includes(user.email.toLowerCase())) {
        await db.user.update({ where: { id: user.id }, data: { isPlatformAdmin: true } });
      }
      await ensurePersonalOrganization(user.id, user.name);
    },
  },
});

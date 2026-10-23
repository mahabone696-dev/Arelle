import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/server/db";
import { ensurePersonalOrganization } from "@/server/organizations/service";
import { getEnv } from "@/server/env";
import { clientIpFromHeaders } from "@/lib/request";
import { authConfig } from "./auth.config";
import { isSignupAllowed, parseSignupAllowlist } from "@/lib/signup-policy";
import { authenticateCredentials } from "./credentials";

function buildProviders(): Provider[] {
  const providers: Provider[] = [
    Credentials({
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(raw, request) {
        const result = await authenticateCredentials(raw, clientIpFromHeaders(request.headers));
        return result.ok ? result.user : null;
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
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account }) {
      // Credentials users were vetted at registration; OAuth sign-ins may create new users here.
      if (account?.provider === "credentials") return true;
      return isSignupAllowed(user.email ?? "", parseSignupAllowlist(process.env.SIGNUP_ALLOWLIST));
    },
  },
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

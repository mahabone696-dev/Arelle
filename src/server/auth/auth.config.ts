/**
 * Auth.js config shared by the request proxy and the full server config.
 * Must not import the database (kept lightweight for the proxy).
 */
import type { NextAuthConfig } from "next-auth";

export const PUBLIC_PATHS = ["/sign-in", "/sign-up", "/api/auth", "/api/health", "/audit", "/r/"];

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

export const authConfig = {
  pages: { signIn: "/sign-in" },
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      // UX redirect only — real authorization happens server-side per request.
      if (isPublicPath(request.nextUrl.pathname)) return true;
      return Boolean(auth?.user);
    },
    jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;

/**
 * Auth.js config shared by the request proxy and the full server config.
 * Must not import the database (kept lightweight for the proxy).
 */
import type { NextAuthConfig } from "next-auth";

// /api/stripe/webhook authenticates by Stripe signature, not by session.
export const PUBLIC_PATHS = ["/sign-in", "/sign-up", "/api/auth", "/api/health", "/api/stripe/webhook", "/audit", "/r/"];

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
      if (auth?.user) return true;
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
      }
      // Only a relative callback: Auth.js' default also copies the page's query string
      // (filters, search terms) onto /sign-in itself.
      // Auth.js requires an absolute Location; the callback itself stays a relative path.
      const signIn = new URL("/sign-in", request.nextUrl);
      signIn.searchParams.set("callbackUrl", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      return Response.redirect(signIn);
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

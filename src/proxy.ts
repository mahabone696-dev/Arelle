import NextAuth from "next-auth";
import { authConfig } from "@/server/auth/auth.config";

// Redirects anonymous users away from app routes. This is a UX convenience;
// every page, action and route handler still authorizes on the server.
export default NextAuth(authConfig).auth;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};

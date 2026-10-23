/**
 * Optional sign-up allow-list for private deployments (previews, betas).
 * SIGNUP_ALLOWLIST="you@company.com, @company.com" — exact emails or "@domain".
 * Empty / unset = open sign-up.
 */
export function parseSignupAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isSignupAllowed(email: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const e = email.trim().toLowerCase();
  const domain = e.slice(e.lastIndexOf("@"));
  return allowlist.some((entry) => (entry.startsWith("@") ? domain === entry : e === entry));
}

/** Public base URL of this deployment (Render sets RENDER_EXTERNAL_URL automatically). */
export function appOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.AUTH_URL || env.RENDER_EXTERNAL_URL || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

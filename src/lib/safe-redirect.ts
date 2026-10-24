/**
 * Resolve a post-login redirect target. Only same-origin destinations are
 * allowed (open-redirect protection); anything else falls back to "/".
 */
export function safeRedirectPath(target: unknown, appOrigin: string): string {
  if (typeof target !== "string" || !target) return "/";
  if (target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/\\")) return target;
  try {
    const origin = new URL(appOrigin).origin;
    const url = new URL(target);
    return url.origin === origin ? `${url.pathname}${url.search}` || "/" : "/";
  } catch {
    return "/";
  }
}

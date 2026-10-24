import { ZodError } from "zod";
import { isAppError, type ActionResult } from "./errors";
import { logger } from "./logger";

/** Maps thrown errors to a user-safe ActionResult. Next.js redirects/notFound are re-thrown. */
export function toActionError(error: unknown, values?: Record<string, string>): ActionResult<never> {
  if (isAppError(error)) return { ok: false, error: error.message, values };
  if (error instanceof ZodError) {
    const flat = error.flatten();
    const first = flat.formErrors[0] ?? error.issues[0]?.message ?? "Check the highlighted fields.";
    return { ok: false, error: first, fieldErrors: flat.fieldErrors as Record<string, string[]>, values };
  }
  const digest = (error as { digest?: unknown })?.digest;
  if (typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"))) throw error;
  logger.error("action.failed", { error });
  return { ok: false, error: "Something went wrong. Please try again.", values };
}

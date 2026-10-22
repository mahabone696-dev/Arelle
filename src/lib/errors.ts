/** Typed application errors. Messages are safe to show to the end user. */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "LIMIT_EXCEEDED"
  | "FEATURE_DISABLED"
  | "UNAVAILABLE"
  | "INTERNAL";

const HTTP_STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 429,
  FEATURE_DISABLED: 403,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Result shape returned by server actions to client forms. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]>; values?: Record<string, string> };

/** Echo non-secret form values back so React 19's post-action form reset keeps user input. */
export function formValues(formData: FormData, omit: readonly string[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData) {
    if (typeof value === "string" && !omit.includes(key) && !key.startsWith("$")) values[key] = value;
  }
  return values;
}

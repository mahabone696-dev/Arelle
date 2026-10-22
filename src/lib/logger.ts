/**
 * Structured JSON logger. One line per event so log drains (Vercel, Datadog,
 * Loki) can index fields. Never log secrets or full AI responses.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED_KEYS = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : "info";
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.test(key)) {
      out[key] = "[REDACTED]";
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as LogFields);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export function createLogger(bindings: LogFields = {}): Logger {
  const minLevel = resolveLevel();
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...redact({ ...bindings, ...fields }),
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (more) => createLogger({ ...bindings, ...more }),
  };
}

export const logger = createLogger({ service: process.env.SERVICE_NAME ?? "web" });

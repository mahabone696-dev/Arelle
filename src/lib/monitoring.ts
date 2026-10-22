/**
 * Error-reporting abstraction. Default reporter logs; a Sentry (or other)
 * reporter can be registered at startup without touching call sites.
 */
import { logger, type LogFields } from "./logger";

export interface ErrorReporter {
  captureException(error: unknown, context?: LogFields): void;
  captureMessage(message: string, context?: LogFields): void;
}

const logReporter: ErrorReporter = {
  captureException(error, context) {
    logger.error("exception", { ...context, error: error instanceof Error ? error : String(error) });
  },
  captureMessage(message, context) {
    logger.warn(message, context);
  },
};

let reporter: ErrorReporter = logReporter;

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

export function captureException(error: unknown, context?: LogFields): void {
  reporter.captureException(error, context);
}

export function captureMessage(message: string, context?: LogFields): void {
  reporter.captureMessage(message, context);
}

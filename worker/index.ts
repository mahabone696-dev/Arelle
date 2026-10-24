/**
 * Background worker process (deploy separately from the web app).
 *   pnpm worker:dev            # watch mode
 *   pnpm worker:build && pnpm worker:start
 *
 * Env must be loaded and SERVICE_NAME set before any module creates its
 * logger, hence the dynamic import.
 */
import "dotenv/config";

process.env.SERVICE_NAME ??= "worker";
await import("./main");

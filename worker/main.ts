/** Worker process body; see worker/index.ts. */
import { z } from "zod";
import { db } from "@/server/db";
import { startScanWorkers } from "@/server/queue/workers";
import { closeQueues } from "@/server/queue/queues";
import { closeSharedRedis } from "@/server/queue/connection";
import { logger } from "@/lib/logger";

const log = logger;

const env = z.object({ DATABASE_URL: z.string().url(), REDIS_URL: z.string().min(1) }).safeParse(process.env);
if (!env.success) {
  log.error("worker.invalid_env", { issues: env.error.issues.map((i) => i.path.join(".")) });
  process.exit(1);
}

const running = await startScanWorkers();
log.info("worker.started", { pid: process.pid });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker.stopping", { signal });
  // Lets in-flight jobs finish (BullMQ waits for active jobs on close).
  const force = setTimeout(() => process.exit(1), 60_000);
  try {
    await running.close();
    await closeQueues();
    await closeSharedRedis();
    await db.$disconnect();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => log.error("worker.unhandled_rejection", { error: reason instanceof Error ? reason : String(reason) }));

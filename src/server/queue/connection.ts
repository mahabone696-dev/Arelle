import { Redis } from "ioredis";

export function redisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  return url;
}

/** New ioredis connection configured for BullMQ (blocking commands require maxRetriesPerRequest: null). */
export function createRedis(env: NodeJS.ProcessEnv = process.env): Redis {
  return new Redis(redisUrl(env), { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

let shared: Redis | undefined;
/** Shared non-blocking connection for queues and quota counters in this process. */
export function sharedRedis(): Redis {
  shared ??= createRedis();
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  await shared?.quit().catch(() => {});
  shared = undefined;
}

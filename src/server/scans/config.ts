/**
 * Scan safety configuration. Values come from env with conservative
 * defaults and hard ceilings, so a misconfiguration can't remove the caps.
 */
const intEnv = (raw: string | undefined, fallback: number, max: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

export interface ScanConfig {
  /** All organizations, all providers, per UTC day. */
  globalDailyQueryCap: number;
  /** Optional extra ceiling per organization per UTC day (the plan limit also applies; the lower wins). */
  orgDailyQueryCap: number;
  maxQueriesPerScan: number;
  /** Attempts per scan job including the first (retries = attempts - 1). */
  jobMaxAttempts: number;
  jobBackoffMs: number;
  /** A RUNNING scan older than this has its unfinished jobs failed by the sweeper. */
  staleScanMs: number;
  /** A QUEUED scan older than this is re-dispatched by the sweeper. */
  stuckQueuedMs: number;
}

export function scanConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  return {
    globalDailyQueryCap: intEnv(env.SCAN_GLOBAL_DAILY_QUERY_CAP, 5_000, 1_000_000),
    orgDailyQueryCap: intEnv(env.SCAN_ORG_DAILY_QUERY_CAP, 10_000, 1_000_000),
    maxQueriesPerScan: intEnv(env.SCAN_MAX_QUERIES_PER_SCAN, 1_000, 10_000),
    jobMaxAttempts: intEnv(env.SCAN_JOB_MAX_ATTEMPTS, 3, 5),
    jobBackoffMs: intEnv(env.SCAN_JOB_BACKOFF_MS, 5_000, 60_000),
    staleScanMs: 6 * 60 * 60 * 1000,
    stuckQueuedMs: 10 * 60 * 1000,
  };
}

export const utcDayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10);

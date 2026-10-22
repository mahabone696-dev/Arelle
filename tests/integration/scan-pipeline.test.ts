/**
 * End-to-end scan pipeline against real Postgres + Redis + BullMQ workers,
 * with a local HTTP server standing in for the OpenAI Responses API.
 * Prompt text drives the fake server's behaviour (FAIL500, FAIL401, FLAKY).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { createProject } from "@/server/projects/service";
import { createScan, getScanDetail, getScanProgress, previewScan, defaultScanDeps } from "@/server/scans/service";
import { setScanKillSwitch } from "@/server/system/settings";
import { startScanWorkers, type RunningWorkers } from "@/server/queue/workers";
import { closeQueues, enqueueScanDispatch, enqueueScanQueries } from "@/server/queue/queues";
import { closeSharedRedis } from "@/server/queue/connection";
import { defaultExecuteDeps, executeScanJob } from "@/server/scans/execute";
import { memoryQuotaGuard } from "@/server/scans/quota";
import { scanConfigFromEnv } from "@/server/scans/config";
import type { PlanTier } from "@/generated/prisma/enums";
import { openAIAnswer } from "../helpers/fake-openai-responses";

const REDIS_TEST_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

let server: Server;
const received: Array<{ input: string; country?: string }> = [];
const flakySeen = new Set<string>();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = JSON.parse(body || "{}");
      received.push({ input: json.input, country: json.tools?.[0]?.user_location?.country });
      const send = (status: number, payload: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      if (String(json.input).includes("FAIL500")) return send(500, { error: { message: "boom", type: "server_error" } });
      if (String(json.input).includes("FAIL401")) return send(401, { error: { message: "bad key", type: "invalid_request_error" } });
      if (String(json.input).includes("FLAKY") && !flakySeen.has(json.input)) {
        flakySeen.add(json.input);
        return send(503, { error: { message: "try later" } });
      }
      send(200, openAIAnswer(`For "${json.input}", **HubSpot** and [Pipedrive](https://pipedrive.com) are popular.`, { citations: [{ url: "https://www.g2.com/categories/crm", title: "G2", at: 10 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  process.env.OPENAI_SCAN_MODEL = "gpt-4.1-mini";
  process.env.REDIS_URL = REDIS_TEST_URL;
  process.env.SCAN_JOB_BACKOFF_MS = "20";
  process.env.SCAN_JOB_MAX_ATTEMPTS = "3";
});

afterAll(async () => {
  await closeQueues();
  await closeSharedRedis();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  received.length = 0;
  flakySeen.clear();
  const r = new Redis(REDIS_TEST_URL);
  await r.flushdb();
  await r.quit();
  await seedProviders();
});

async function seedProviders() {
  const openai = await db.aIProvider.create({ data: { slug: "openai", displayName: "ChatGPT", isEnabled: true, maxConcurrency: 3, requestsPerMinute: 600, dailyQueryCap: 1000 } });
  await db.aIModel.create({ data: { providerId: openai.id, modelId: "gpt-4.1-mini", displayName: "GPT-4.1 mini", inputCostPer1M: 0.4, outputCostPer1M: 1.6, requestCost: 0.025, isDefault: true } });
  await db.aIProvider.create({ data: { slug: "gemini", displayName: "Gemini", isEnabled: true } });
}

async function setupProject(prompts: string[], tier: PlanTier = "GROWTH", email = `u${Math.random()}@t.com`) {
  const user = await db.user.create({ data: { email } });
  const org = await createOrganization(user.id, { name: "Scan Co" });
  await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: tier } });
  const project = await createProject(user.id, org.id, { name: "Acme", domain: `acme${Math.floor(Math.random() * 1e9)}.com`, country: "GB", language: "en" });
  for (const [i, text] of prompts.entries()) {
    await db.prompt.create({ data: { projectId: project.id, text, intent: "COMMERCIAL", country: "GB", language: "en", priority: 5 - (i % 5), isActive: true, approvedAt: new Date() } });
  }
  return { user, org, project };
}

async function waitForScan(scanId: string, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const s = await db.scan.findUniqueOrThrow({ where: { id: scanId } });
    if (!["QUEUED", "RUNNING"].includes(s.status)) return s;
    if (Date.now() - started > timeoutMs) throw new Error(`scan ${scanId} still ${s.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function withWorkers<T>(fn: () => Promise<T>): Promise<T> {
  const workers: RunningWorkers = await startScanWorkers({ sweepEveryMs: 0 });
  try {
    return await fn();
  } finally {
    await workers.close();
  }
}

const FIVE = ["Best CRM for startups", "Best CRM software", "HubSpot alternatives", "Affordable CRM for small companies", "CRM with email automation"];

describe("scan pipeline", () => {
  it("plans, dispatches and completes a 5-prompt scan, storing immutable responses with cost", async () => {
    const { user, project, org } = await setupProject(FIVE);

    const preview = await previewScan(user.id, project.id);
    expect(preview).toMatchObject({ promptCount: 5, providerCount: 1, expectedQueryCount: 5, killSwitch: false });
    expect(preview.estimatedCost).toBeGreaterThan(0);
    // Gemini is enabled in the DB but has no adapter in this build: reported, not silently used.
    expect(preview.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "gemini", reason: "FEATURE_OFF" })]));

    const scan = await createScan(user.id, project.id);
    expect(scan).toMatchObject({ status: "QUEUED", promptCount: 5, providerCount: 1, expectedQueryCount: 5 });
    expect(await db.scanJob.count({ where: { scanId: scan.id } })).toBe(5);

    const done = await withWorkers(() => waitForScan(scan.id));
    expect(done).toMatchObject({ status: "COMPLETED", completedCount: 5, failedCount: 0, skippedCount: 0 });
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();

    const responses = await db.aIResponse.findMany({ where: { scanId: scan.id } });
    expect(responses).toHaveLength(5);
    for (const r of responses) {
      expect(r).toMatchObject({ country: "GB", language: "en", model: "gpt-4.1-mini-2025-04-14", inputTokens: 1200, outputTokens: 400 });
      expect(r.normalizedText).toContain("HubSpot and Pipedrive are popular");
      expect(r.rawText).toContain("**HubSpot**");
      expect((r.metadata as { citations: unknown[] }).citations).toEqual([{ url: "https://www.g2.com/categories/crm", title: "G2", position: 1 }]);
    }
    expect(received.map((q) => q.input).sort()).toEqual([...FIVE].sort());
    expect(received.every((q) => q.country === "GB")).toBe(true);

    const perQuery = 0.00048 + 0.00064 + 0.025;
    expect(Number(done.actualCost)).toBeCloseTo(5 * perQuery, 6);
    const usage = await db.usageRecord.findMany({ where: { organizationId: org.id, metric: "PROVIDER_QUERY" } });
    expect(usage).toHaveLength(5);
    expect(usage.reduce((a, u) => a + Number(u.costUsd), 0)).toBeCloseTo(5 * perQuery, 6);

    const progress = await getScanProgress(user.id, project.id, scan.id);
    expect(progress).toMatchObject({ status: "COMPLETED", processed: 5, expectedQueryCount: 5 });
    const detail = await getScanDetail(user.id, project.id, scan.id);
    expect(detail.jobs.every((j) => j.status === "SUCCEEDED" && j.attempts === 1 && j.response)).toBe(true);

    // Immutability is enforced by the database itself.
    const err = await db.aIResponse.update({ where: { id: responses[0]!.id }, data: { rawText: "rewritten" } }).catch((e: unknown) => e);
    expect(String((err as Error).message) + JSON.stringify((err as { meta?: unknown }).meta ?? {})).toMatch(/immutable/);
    expect(err).toBeInstanceOf(Error);
    expect((await db.aIResponse.findUniqueOrThrow({ where: { id: responses[0]!.id } })).rawText).toContain("**HubSpot**");
    // A new scan never overwrites the previous one.
    expect(await db.aIResponse.count({ where: { promptId: responses[0]!.promptId } })).toBe(1);
  });

  it("isolates provider failures: retries transient errors, fails fast on auth errors, finishes PARTIAL", async () => {
    const { user, project } = await setupProject(["Good one", "Good two", "FLAKY prompt", "FAIL500 prompt", "FAIL401 prompt"]);
    const scan = await createScan(user.id, project.id);
    const done = await withWorkers(() => waitForScan(scan.id));
    expect(done).toMatchObject({ status: "PARTIAL", completedCount: 3, failedCount: 2, skippedCount: 0 });
    expect(done.errorSummary).toContain("UNAVAILABLE: 1");
    expect(done.errorSummary).toContain("AUTH: 1");

    const jobs = await db.scanJob.findMany({ where: { scanId: scan.id }, include: { prompt: true } });
    const byText = Object.fromEntries(jobs.map((j) => [j.prompt.text, j]));
    expect(byText["FLAKY prompt"]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(byText["FAIL500 prompt"]).toMatchObject({ status: "FAILED", attempts: 3, errorCode: "UNAVAILABLE" });
    expect(byText["FAIL401 prompt"]).toMatchObject({ status: "FAILED", attempts: 1, errorCode: "AUTH" });
    expect(received.filter((q) => q.input === "FAIL500 prompt")).toHaveLength(3);
    expect(received.filter((q) => q.input === "FAIL401 prompt")).toHaveLength(1);
    expect(await db.aIResponse.count({ where: { scanId: scan.id } })).toBe(3);
  });

  it("re-dispatching and re-enqueueing never duplicates paid queries", async () => {
    const { user, project } = await setupProject(FIVE);
    const scan = await createScan(user.id, project.id);
    const jobIds = (await db.scanJob.findMany({ where: { scanId: scan.id }, select: { id: true } })).map((j) => j.id);
    await enqueueScanDispatch(scan.id);
    await enqueueScanQueries("openai", jobIds);
    await enqueueScanQueries("openai", jobIds);
    const done = await withWorkers(() => waitForScan(scan.id));
    expect(done.status).toBe("COMPLETED");
    expect(received).toHaveLength(5);
    // Executing a finished job again is a no-op.
    const deps = defaultExecuteDeps(memoryQuotaGuard());
    expect(await executeScanJob(jobIds[0]!, 1, 3, deps)).toEqual({ kind: "NOOP" });
    expect(received).toHaveLength(5);
  });

  it("kill switch: blocks new scans, and halts queued scans without calling the provider", async () => {
    const { user, project } = await setupProject(FIVE);
    const scan = await createScan(user.id, project.id);
    await setScanKillSwitch({ enabled: true, reason: "test" }, "test");
    await expect(createScan(user.id, project.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const done = await withWorkers(() => waitForScan(scan.id));
    expect(done).toMatchObject({ status: "CANCELLED", completedCount: 0, skippedCount: 5 });
    expect(await db.scanJob.count({ where: { scanId: scan.id, errorCode: "KILL_SWITCH" } })).toBe(5);
    expect(received).toHaveLength(0);
    await setScanKillSwitch({ enabled: false }, "test");
  });

  it("runtime quota stops paid calls at the cap and skips the rest transparently", async () => {
    const { user, project } = await setupProject(FIVE);
    const scan = await createScan(user.id, project.id);
    const quota = memoryQuotaGuard();
    const config = { ...scanConfigFromEnv(), orgDailyQueryCap: 2 };
    const deps = { ...defaultExecuteDeps(quota), config };
    await db.scan.update({ where: { id: scan.id }, data: { status: "RUNNING" } });
    for (const j of await db.scanJob.findMany({ where: { scanId: scan.id }, orderBy: { id: "asc" } })) await executeScanJob(j.id, 1, 3, deps);
    const done = await db.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(done).toMatchObject({ status: "PARTIAL", completedCount: 2, skippedCount: 3 });
    expect(await db.scanJob.count({ where: { scanId: scan.id, errorCode: "DAILY_CAP_ORG" } })).toBe(3);
    expect(received).toHaveLength(2);
  });
});

describe("scan admission limits", () => {
  const noQueue = () => ({ ...defaultScanDeps(), enqueueDispatch: async () => {} });

  it("computes the plan and enforces one active scan per project", async () => {
    const { user, project } = await setupProject(FIVE);
    await createScan(user.id, project.id, {}, noQueue());
    await expect(createScan(user.id, project.id, {}, noQueue())).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("enforces plan limits: FREE allows 1 manual scan/day and 10 prompts", async () => {
    const free = await setupProject(FIVE, "FREE");
    const s = await createScan(free.user.id, free.project.id, {}, noQueue());
    await db.scan.update({ where: { id: s.id }, data: { status: "COMPLETED" } });
    await expect(createScan(free.user.id, free.project.id, {}, noQueue())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    const big = await setupProject(Array.from({ length: 11 }, (_, i) => `prompt ${i}`), "FREE");
    await expect(createScan(big.user.id, big.project.id, {}, noQueue())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", message: expect.stringContaining("10 prompts") });
  });

  it("enforces the configurable daily query cap before dispatch, counting earlier scans", async () => {
    const { user, project } = await setupProject(FIVE);
    const deps = { ...noQueue(), config: { ...scanConfigFromEnv(), orgDailyQueryCap: 8 } };
    const first = await createScan(user.id, project.id, {}, deps);
    await db.scan.update({ where: { id: first.id }, data: { status: "COMPLETED" } });
    await expect(createScan(user.id, project.id, {}, deps)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", message: expect.stringContaining("5 of 8") });
    // Nothing was created by the refused attempt.
    expect(await db.scan.count({ where: { projectId: project.id } })).toBe(1);
  });

  it("enforces the per-scan maximum and the global daily cap", async () => {
    const { user, project } = await setupProject(FIVE);
    await expect(createScan(user.id, project.id, {}, { ...noQueue(), config: { ...scanConfigFromEnv(), maxQueriesPerScan: 4 } })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(createScan(user.id, project.id, {}, { ...noQueue(), config: { ...scanConfigFromEnv(), globalDailyQueryCap: 4 } })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await db.scan.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("refuses when no provider is ready, and explains why", async () => {
    const { user, project } = await setupProject(FIVE);
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(createScan(user.id, project.id, {}, noQueue())).rejects.toMatchObject({ code: "UNAVAILABLE", details: { unavailable: expect.arrayContaining([expect.objectContaining({ slug: "openai", reason: "NOT_CONFIGURED" })]) } });
    } finally {
      process.env.OPENAI_API_KEY = key;
    }
  });

  it("marks the scan FAILED (and skips its jobs) when the queue is unavailable", async () => {
    const { user, project } = await setupProject(FIVE);
    await expect(createScan(user.id, project.id, {}, { ...defaultScanDeps(), enqueueDispatch: async () => Promise.reject(new Error("redis down")) })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const s = await db.scan.findFirstOrThrow({ where: { projectId: project.id } });
    expect(s).toMatchObject({ status: "FAILED", skippedCount: 5 });
  });

  it("isolates organizations", async () => {
    const { user, project } = await setupProject(FIVE);
    const scan = await createScan(user.id, project.id, {}, noQueue());
    const mallory = await db.user.create({ data: { email: "m@evil.com" } });
    await expect(createScan(mallory.id, project.id, {}, noQueue())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(previewScan(mallory.id, project.id, noQueue())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getScanProgress(mallory.id, project.id, scan.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Scan ids from another project don't resolve under a project the user can access.
    const own = await setupProject(FIVE, "GROWTH", "own@m.com");
    await expect(getScanProgress(own.user.id, own.project.id, scan.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("viewers cannot start scans", async () => {
    const { org, project } = await setupProject(FIVE);
    const viewer = await db.user.create({ data: { email: "viewer@t.com" } });
    await db.organizationMember.create({ data: { organizationId: org.id, userId: viewer.id, role: "VIEWER" } });
    await expect(createScan(viewer.id, project.id, {}, noQueue())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

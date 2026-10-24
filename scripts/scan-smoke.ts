/**
 * Real end-to-end scan: project → 5 prompts → scan → worker → every configured engine → DB.
 *
 *   pnpm scan:smoke --yes                 # runs the worker in-process
 *   pnpm scan:smoke --yes --external      # expects `pnpm worker:dev` running separately
 *
 * Requires DATABASE_URL, REDIS_URL, at least one of OPENAI_API_KEY / GEMINI_API_KEY /
 * PERPLEXITY_API_KEY (Gemini and Perplexity also need FEATURE_GEMINI / FEATURE_PERPLEXITY and
 * `pnpm admin provider enable <slug>`), and `pnpm db:seed` for model pricing.
 * Spends real money: 5 grounded queries per ready engine (the plan below prints the estimate).
 * Uses the same admission path as the UI: kill switch, caps and plan limits all apply.
 */
import "dotenv/config";
import { db } from "@/server/db";
import { createScan, getScanDetail, previewScan } from "@/server/scans/service";
import { startScanWorkers } from "@/server/queue/workers";
import { closeQueues } from "@/server/queue/queues";
import { closeSharedRedis } from "@/server/queue/connection";
import { getScanKillSwitch } from "@/server/system/settings";

const args = new Set(process.argv.slice(2));
const DOMAIN = process.env.SMOKE_DOMAIN ?? "pipedrive.com";
const PROMPTS = ["Best CRM for startups", "Best CRM software for small businesses", "HubSpot alternatives", "Pipedrive vs HubSpot", "Affordable CRM for real estate agents"];

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  for (const k of ["DATABASE_URL", "REDIS_URL"]) if (!process.env[k]) fail(`${k} is not set.`);
  if (!["OPENAI_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY"].some((k) => process.env[k])) fail("No provider key is set (OPENAI_API_KEY, GEMINI_API_KEY or PERPLEXITY_API_KEY).");
  if (!args.has("--yes")) fail("This makes 5 paid requests per ready engine. Re-run with --yes to confirm.");
  if ((await getScanKillSwitch()).enabled) fail("The scan kill switch is ON (pnpm admin kill-switch off).");

  // 1. Test tenant (clearly labelled), project and 5 approved prompts.
  const user = await db.user.upsert({ where: { email: "scan-smoke@arelle.local" }, create: { email: "scan-smoke@arelle.local", name: "Scan smoke test" }, update: {} });
  let org = await db.organization.findUnique({ where: { slug: "scan-smoke-test" } });
  org ??= await db.organization.create({
    data: { name: "Scan smoke test", slug: "scan-smoke-test", members: { create: { userId: user.id, role: "OWNER" } }, subscription: { create: { planTier: "GROWTH" } } },
  });
  const project = await db.project.upsert({
    where: { organizationId_domain: { organizationId: org.id, domain: DOMAIN } },
    create: { organizationId: org.id, name: `Smoke test — ${DOMAIN}`, domain: DOMAIN, country: "US", language: "en", locale: "en-US", onboardingStep: "COMPLETED", onboardingCompletedAt: new Date() },
    update: {},
  });
  await db.prompt.updateMany({ where: { projectId: project.id, text: { notIn: PROMPTS } }, data: { isActive: false } });
  for (const text of PROMPTS) {
    await db.prompt.upsert({
      where: { projectId_text_country_language: { projectId: project.id, text, country: "US", language: "en" } },
      create: { projectId: project.id, text, intent: "COMMERCIAL", country: "US", language: "en", isActive: true, approvedAt: new Date(), reviewedAt: new Date(), source: "USER" },
      update: { isActive: true },
    });
  }
  console.log(`Project ${project.id} (${DOMAIN}) with ${PROMPTS.length} active prompts`);

  // 2. Plan + admission (same path as the UI).
  const preview = await previewScan(user.id, project.id);
  console.log(`Plan: ${preview.promptCount} prompts × ${preview.providerCount} provider(s) = ${preview.expectedQueryCount} queries, est. $${preview.estimatedCost.toFixed(4)}`);
  for (const u of preview.unavailable) console.log(`  not used: ${u.slug} (${u.reason})`);
  if (preview.blockedReason) fail(preview.blockedReason);
  const scan = await createScan(user.id, project.id);
  console.log(`Scan ${scan.id} queued`);

  // 3. Process.
  const workers = args.has("--external") ? null : await startScanWorkers({ sweepEveryMs: 0 });
  const started = Date.now();
  let last = -1;
  for (;;) {
    const s = await db.scan.findUniqueOrThrow({ where: { id: scan.id } });
    const processed = s.completedCount + s.failedCount + s.skippedCount;
    if (processed !== last) {
      console.log(`  Scanning ${processed} / ${s.expectedQueryCount} responses (${s.status})`);
      last = processed;
    }
    if (!["QUEUED", "RUNNING"].includes(s.status)) break;
    if (Date.now() - started > 5 * 60_000) fail("Timed out after 5 minutes.");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await workers?.close();

  // 4. Inspect what was stored.
  const { scan: final, jobs } = await getScanDetail(user.id, project.id, scan.id);
  console.log(`\nScan ${final.status}: ${final.completedCount} answers, ${final.failedCount} failed, ${final.skippedCount} skipped · cost $${final.actualCost.toFixed(4)} (est. $${final.estimatedCost.toFixed(4)})`);
  for (const j of jobs) {
    const r = j.response;
    const cites = ((r?.metadata as { citations?: unknown[] } | undefined)?.citations ?? []).length;
    console.log(`\n• [${j.provider.displayName}] ${j.prompt.text}\n  ${j.status} · attempts ${j.attempts}${r ? ` · ${r.model} · ${r.latencyMs}ms · ${r.inputTokens}/${r.outputTokens} tokens · $${Number(r.estimatedCost).toFixed(4)} · ${cites} citations` : ` · ${j.errorCode}: ${j.lastError}`}`);
    if (r) console.log(`  “${r.normalizedText.slice(0, 160).replace(/\n/g, " ")}…”`);
  }
  const stored = await db.aIResponse.groupBy({ by: ["providerId"], where: { scanId: scan.id }, _count: true });
  console.log(`\nAIResponse rows stored for this scan: ${stored.reduce((n, g) => n + g._count, 0)}`);
  for (const j of jobs.filter((j, i, all) => all.findIndex((x) => x.provider.displayName === j.provider.displayName) === i)) {
    const mine = jobs.filter((x) => x.provider.displayName === j.provider.displayName);
    const meta = mine.find((x) => x.response)?.response?.metadata as Record<string, unknown> | undefined;
    console.log(`  ${j.provider.displayName}: ${mine.filter((x) => x.response).length}/${mine.length} answers · localized=${meta?.locationSupported !== false} · ${JSON.stringify(meta?.citationResolution ?? meta?.citationSource ?? null)}`);
  }
  if (final.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await closeSharedRedis();
    await db.$disconnect();
  });

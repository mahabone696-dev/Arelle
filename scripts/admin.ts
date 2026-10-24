/**
 * Operator CLI until the admin UI ships (Phase 9).
 *   pnpm admin kill-switch on "incident #12"   # stop dispatching paid queries now
 *   pnpm admin kill-switch off
 *   pnpm admin kill-switch status
 *   pnpm admin provider status
 *   pnpm admin provider enable openai | disable openai
 *   pnpm admin analyze <scanId>                # (re)run response analysis + snapshots for a scan
 *   pnpm admin opportunities <projectId>       # re-evaluate opportunities and recommendations now
 *   pnpm admin plan <orgSlug> [FREE|STARTER|GROWTH|AGENCY]  # show or set a plan by hand (no Stripe)
 */
import "dotenv/config";
import { db } from "@/server/db";
import { getScanKillSwitch, setScanKillSwitch } from "@/server/system/settings";
import { getProviderAvailability, UNAVAILABLE_LABELS } from "@/server/providers/registry";
import { analyzeScan } from "@/server/analysis/service";
import { afterScanAnalyzed, evaluateProject } from "@/server/opportunities/service";

const [area, action, arg] = process.argv.slice(2);
const actor = process.env.USER ? `cli:${process.env.USER}` : "cli";

async function main() {
  if (area === "kill-switch") {
    if (action === "on") await setScanKillSwitch({ enabled: true, reason: arg ?? "manual" }, actor);
    else if (action === "off") await setScanKillSwitch({ enabled: false }, actor);
    else if (action !== "status") throw new Error("usage: kill-switch on [reason] | off | status");
    console.log("scan kill switch:", await getScanKillSwitch());
    return;
  }
  if (area === "provider") {
    if (action === "enable" || action === "disable") {
      if (!arg) throw new Error("usage: provider enable|disable <slug>");
      await db.aIProvider.update({ where: { slug: arg }, data: { isEnabled: action === "enable" } });
    } else if (action !== "status") throw new Error("usage: provider status | enable <slug> | disable <slug>");
    const a = await getProviderAvailability();
    for (const p of a.ready) console.log(`READY        ${p.slug.padEnd(11)} model=${p.modelId} concurrency=${p.maxConcurrency} rpm=${p.requestsPerMinute} dailyCap=${p.dailyQueryCap}`);
    for (const p of a.unavailable) console.log(`UNAVAILABLE  ${p.slug.padEnd(11)} ${UNAVAILABLE_LABELS[p.reason]} (${p.reason})`);
    return;
  }
  if (area === "analyze") {
    if (!action) throw new Error("usage: analyze <scanId>");
    // Re-running is safe: answers already analyzed at the current version are skipped.
    await db.scan.update({ where: { id: action }, data: { analysisStatus: null } });
    console.log("analysis:", await analyzeScan(action));
    await afterScanAnalyzed(action);
    const snaps = await db.visibilitySnapshot.findMany({ where: { scanId: action, competitorId: null }, include: { provider: { select: { slug: true } } } });
    for (const s of snaps) console.log(`  ${s.provider?.slug ?? "all"} ${s.country}/${s.language}: score ${s.visibilityScore} · mention ${s.mentionRate} · SoV ${s.shareOfVoice} · avg pos ${s.averagePosition ?? "—"} · cited ${s.citationRate} · n=${s.sampleSize}`);
    return;
  }
  if (area === "opportunities") {
    if (!action) throw new Error("usage: opportunities <projectId>");
    console.log("opportunities:", (await evaluateProject(action)) ?? "no analyzed answers in the last 30 days");
    const open = await db.opportunity.findMany({ where: { projectId: action, status: "OPEN" }, orderBy: { impactScore: "desc" }, select: { type: true, impactScore: true, title: true } });
    for (const o of open) console.log(`  ${String(Math.round(o.impactScore)).padStart(3)}  ${o.type.padEnd(21)} ${o.title}`);
    return;
  }
  if (area === "plan") {
    if (!action) throw new Error("usage: plan <orgSlug> [FREE|STARTER|GROWTH|AGENCY]");
    const org = await db.organization.findUniqueOrThrow({ where: { slug: action }, include: { subscription: true } });
    if (arg) {
      const tier = arg.toUpperCase();
      if (!["FREE", "STARTER", "GROWTH", "AGENCY"].includes(tier)) throw new Error(`unknown plan ${arg}`);
      if (org.subscription?.stripeSubscriptionId && !["CANCELED", "UNPAID", "INCOMPLETE"].includes(org.subscription.status)) {
        throw new Error("This organization has a live Stripe subscription; change it in Stripe (the webhook keeps us in sync).");
      }
      await db.subscription.upsert({ where: { organizationId: org.id }, create: { organizationId: org.id, planTier: tier as "FREE", status: "ACTIVE" }, update: { planTier: tier as "FREE", status: "ACTIVE" } });
      await db.auditLog.create({ data: { organizationId: org.id, action: "billing.plan_set_manually", entityType: "Subscription", metadata: { tier, actor } } });
    }
    const sub = await db.subscription.findUnique({ where: { organizationId: org.id } });
    console.log(`${org.slug}: ${sub?.planTier ?? "FREE"} (${sub?.status ?? "—"})${sub?.stripeSubscriptionId ? ` · stripe ${sub.stripeSubscriptionId}` : ""}`);
    return;
  }
  throw new Error("usage: admin kill-switch|provider|analyze|opportunities|plan ...");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

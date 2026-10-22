/**
 * Operator CLI until the admin UI ships (Phase 9).
 *   pnpm admin kill-switch on "incident #12"   # stop dispatching paid queries now
 *   pnpm admin kill-switch off
 *   pnpm admin kill-switch status
 *   pnpm admin provider status
 *   pnpm admin provider enable openai | disable openai
 */
import "dotenv/config";
import { db } from "@/server/db";
import { getScanKillSwitch, setScanKillSwitch } from "@/server/system/settings";
import { getProviderAvailability, UNAVAILABLE_LABELS } from "@/server/providers/registry";

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
  throw new Error("usage: admin kill-switch|provider ...");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

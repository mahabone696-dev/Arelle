/**
 * Global system settings. The scan kill switch is read by the dispatcher and
 * by every query job (Phase 3) so an incident can halt paid provider calls.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { logger } from "@/lib/logger";

export const KILL_SWITCH_KEY = "scan.killSwitch";

const killSwitchSchema = z.object({ enabled: z.boolean(), reason: z.string().optional() });
export type KillSwitchState = z.infer<typeof killSwitchSchema>;

export async function getScanKillSwitch(): Promise<KillSwitchState> {
  const row = await db.systemSetting.findUnique({ where: { key: KILL_SWITCH_KEY } });
  const parsed = killSwitchSchema.safeParse(row?.value);
  // Fail closed if the stored value is corrupted.
  if (row && !parsed.success) return { enabled: true, reason: "Invalid kill switch value" };
  return parsed.success ? parsed.data : { enabled: false };
}

export async function setScanKillSwitch(state: KillSwitchState, actorId: string): Promise<void> {
  const value = killSwitchSchema.parse(state);
  await db.systemSetting.upsert({
    where: { key: KILL_SWITCH_KEY },
    create: { key: KILL_SWITCH_KEY, value, updatedBy: actorId },
    update: { value, updatedBy: actorId },
  });
  await writeAuditLog({ actorId, action: value.enabled ? "system.kill_switch.on" : "system.kill_switch.off", entityType: "SystemSetting", entityId: KILL_SWITCH_KEY, metadata: value });
  logger.warn("system.kill_switch.changed", { enabled: value.enabled, actorId });
}

import { db } from "@/server/db";
import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  organizationId?: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

type AuditWriter = Pick<typeof db, "auditLog">;

/**
 * Append an audit log entry. Failures are logged, never thrown, so auditing
 * cannot break the user-facing operation. Pass a transaction client to make
 * the entry atomic with the change.
 */
export async function writeAuditLog(entry: AuditEntry, client: AuditWriter = db): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        organizationId: entry.organizationId ?? null,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
      },
    });
  } catch (error) {
    logger.error("audit_log.write_failed", { action: entry.action, error });
  }
}

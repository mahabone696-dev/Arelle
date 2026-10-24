import { db, type DbTransaction } from "@/server/db";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { slugify } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { createOrganizationSchema, RESERVED_SLUGS, type CreateOrganizationInput } from "./schemas";

async function uniqueSlug(tx: DbTransaction, name: string): Promise<string> {
  let base = slugify(name) || "workspace";
  if (base.length < 3 || RESERVED_SLUGS.has(base)) base = `${base}-team`.replace(/^-/, "");
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 7)}`;
    const exists = await tx.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  throw new Error("Could not allocate an organization slug");
}

/** Create an organization with the user as OWNER and a FREE subscription. */
export async function createOrganization(userId: string, input: CreateOrganizationInput) {
  const { name } = createOrganizationSchema.parse(input);
  const org = await db.$transaction(async (tx) => {
    const slug = await uniqueSlug(tx, name);
    const created = await tx.organization.create({
      data: {
        name,
        slug,
        members: { create: { userId, role: "OWNER" } },
        subscription: { create: { planTier: "FREE", status: "ACTIVE" } },
      },
    });
    await writeAuditLog(
      { organizationId: created.id, actorId: userId, action: "organization.created", entityType: "Organization", entityId: created.id },
      tx,
    );
    return created;
  });
  logger.info("organization.created", { organizationId: org.id, userId });
  return org;
}

/** Ensure a newly signed-up user has a workspace to land in. Idempotent. */
export async function ensurePersonalOrganization(userId: string, displayName?: string | null) {
  const existing = await db.organizationMember.findFirst({ where: { userId }, select: { organizationId: true } });
  if (existing) return existing.organizationId;
  const first = displayName?.trim().split(/\s+/)[0];
  const org = await createOrganization(userId, { name: first ? `${first}'s workspace` : "My workspace" });
  return org.id;
}

export function listOrganizationsForUser(userId: string) {
  return db.organization.findMany({
    where: { members: { some: { userId } } },
    select: { id: true, name: true, slug: true, isDemo: true, members: { where: { userId }, select: { role: true } } },
    orderBy: { createdAt: "asc" },
  });
}

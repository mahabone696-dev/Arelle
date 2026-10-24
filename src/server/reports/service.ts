/**
 * Shareable read-only reports.
 *
 * A share link is a random 256-bit token; only its SHA-256 is stored, so the
 * link is shown once and a database leak doesn't expose working links. Links
 * can expire and be revoked, and stop working if the organization's plan no
 * longer includes reports. The report itself is live data for a fixed range.
 * `branding` (agency name, accent colour) prepares white-label agency reports.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { requireProjectAccess } from "@/server/auth/authorization";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { assertFeature, hasFeature } from "@/server/billing/limits";
import { isFeatureEnabled } from "@/server/flags/flags";
import { buildProjectReport } from "@/server/dashboard/metrics";
import { AppError } from "@/lib/errors";
import { parseDateRange, type DateRangeKey } from "@/lib/date-range";

const DAY = 86_400_000;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface ReportBranding {
  agencyName?: string;
  /** #rrggbb */
  accentColor?: string;
}

export const shareSchema = z.object({
  title: z.string().trim().max(120).optional().or(z.literal("").transform(() => undefined)),
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  expiresInDays: z.coerce.number().int().refine((n) => [0, 7, 30, 90].includes(n), "Choose an expiry").default(30),
  agencyName: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2a78d6")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function createShareLink(userId: string, projectId: string, raw: unknown, now = new Date()) {
  const input = shareSchema.parse(raw);
  const access = await requireProjectAccess(userId, projectId, "report:share");
  if (!(await isFeatureEnabled("reports", access.organizationId))) throw new AppError("FEATURE_DISABLED", "Report sharing is turned off on this deployment.");
  await assertFeature(access.organizationId, "reports");
  const token = randomBytes(32).toString("base64url");
  const branding: ReportBranding = { ...(input.agencyName ? { agencyName: input.agencyName } : {}), ...(input.accentColor ? { accentColor: input.accentColor.toLowerCase() } : {}) };
  const share = await db.reportShare.create({
    data: {
      projectId,
      tokenHash: hashToken(token),
      title: input.title ?? null,
      range: input.range,
      branding: branding as object,
      expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * DAY) : null,
      createdById: userId,
    },
    select: { id: true, expiresAt: true },
  });
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "report.share_created", entityType: "ReportShare", entityId: share.id, metadata: { projectId, range: input.range, expiresAt: share.expiresAt?.toISOString() ?? null } });
  // The raw token leaves the server exactly once.
  return { id: share.id, token, path: `/r/${token}`, expiresAt: share.expiresAt };
}

export async function listShareLinks(userId: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  const links = await db.reportShare.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, range: true, branding: true, viewCount: true, lastViewedAt: true, expiresAt: true, revokedAt: true, createdAt: true, createdBy: { select: { name: true, email: true } } },
  });
  const now = Date.now();
  return {
    entitled: await hasFeature(access.organizationId, "reports"),
    enabled: await isFeatureEnabled("reports", access.organizationId),
    links: links.map((l) => ({ ...l, branding: l.branding as ReportBranding, status: l.revokedAt ? ("REVOKED" as const) : l.expiresAt && l.expiresAt.getTime() <= now ? ("EXPIRED" as const) : ("ACTIVE" as const) })),
  };
}

export async function revokeShareLink(userId: string, projectId: string, shareId: string) {
  const access = await requireProjectAccess(userId, projectId, "report:share");
  const { count } = await db.reportShare.updateMany({ where: { id: shareId, projectId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!count) throw new AppError("NOT_FOUND", "Share link not found.");
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "report.share_revoked", entityType: "ReportShare", entityId: shareId });
}

export type ShareResolution =
  | { ok: true; shareId: string; title: string | null; range: DateRangeKey; branding: ReportBranding; report: Awaited<ReturnType<typeof buildProjectReport>> }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "REVOKED" | "PLAN" };

/**
 * Resolve a public share token to its report. Unknown, revoked and expired
 * tokens are indistinguishable to the outside except for a generic message.
 */
export async function resolveShare(token: string, now = new Date()): Promise<ShareResolution> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return { ok: false, reason: "NOT_FOUND" };
  const share = await db.reportShare.findUnique({ where: { tokenHash: hashToken(token) }, select: { id: true, projectId: true, title: true, range: true, branding: true, expiresAt: true, revokedAt: true, project: { select: { organizationId: true } } } });
  if (!share) return { ok: false, reason: "NOT_FOUND" };
  if (share.revokedAt) return { ok: false, reason: "REVOKED" };
  if (share.expiresAt && share.expiresAt <= now) return { ok: false, reason: "EXPIRED" };
  // The flag works as an off switch for all public report links.
  if (!(await isFeatureEnabled("reports", share.project.organizationId))) return { ok: false, reason: "PLAN" };
  // A downgraded organization's links pause (they resume if the plan is restored).
  if (!(await hasFeature(share.project.organizationId, "reports"))) return { ok: false, reason: "PLAN" };
  const range = parseDateRange(share.range);
  const report = await buildProjectReport(share.projectId, range);
  await db.reportShare.update({ where: { id: share.id }, data: { viewCount: { increment: 1 }, lastViewedAt: now } });
  return { ok: true, shareId: share.id, title: share.title, range, branding: share.branding as ReportBranding, report };
}

/** In-app preview for members (same report, no share link). */
export async function previewReport(userId: string, projectId: string, range: DateRangeKey) {
  await requireProjectAccess(userId, projectId, "project:read");
  return buildProjectReport(projectId, range);
}

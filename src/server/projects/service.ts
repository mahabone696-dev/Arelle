import { db } from "@/server/db";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { requireOrgAccess, requireProjectAccess } from "@/server/auth/authorization";
import { AppError } from "@/lib/errors";
import { toLocale } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { Prisma } from "@/generated/prisma/client";
import { assertCanCreateProject } from "@/server/billing/limits";
import { createProjectSchema, updateProjectSchema, type CreateProjectInput, type UpdateProjectInput } from "./schemas";

const projectSummarySelect = {
  id: true,
  name: true,
  domain: true,
  country: true,
  language: true,
  locale: true,
  timezone: true,
  createdAt: true,
} satisfies Prisma.ProjectSelect;

export type ProjectSummary = Prisma.ProjectGetPayload<{ select: typeof projectSummarySelect }>;

export async function createProject(userId: string, organizationId: string, input: CreateProjectInput) {
  const access = await requireOrgAccess(userId, { id: organizationId }, "project:create");
  const data = createProjectSchema.parse(input);
  try {
    const project = await db.$transaction(async (tx) => {
      await assertCanCreateProject(tx, access.organizationId, data.domain);
      const created = await tx.project.create({
        data: {
          organizationId: access.organizationId,
          name: data.name,
          domain: data.domain,
          country: data.country,
          language: data.language,
          locale: toLocale(data.language, data.country),
          timezone: data.timezone,
        },
        select: projectSummarySelect,
      });
      await writeAuditLog(
        {
          organizationId: access.organizationId,
          actorId: userId,
          action: "project.created",
          entityType: "Project",
          entityId: created.id,
          metadata: { domain: created.domain },
        },
        tx,
      );
      return created;
    });
    logger.info("project.created", { projectId: project.id, organizationId: access.organizationId });
    return project;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("CONFLICT", "A project for this domain already exists in this organization.");
    }
    throw error;
  }
}

export async function updateProject(userId: string, projectId: string, input: UpdateProjectInput) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const data = updateProjectSchema.parse(input);
  const current = await db.project.findUniqueOrThrow({ where: { id: access.projectId }, select: { country: true, language: true } });
  const country = data.country ?? current.country;
  const language = data.language ?? current.language;
  const project = await db.project.update({
    where: { id: access.projectId },
    data: { ...data, locale: toLocale(language, country) },
    select: projectSummarySelect,
  });
  await writeAuditLog({
    organizationId: access.organizationId,
    actorId: userId,
    action: "project.updated",
    entityType: "Project",
    entityId: project.id,
    metadata: data,
  });
  return project;
}

export async function listProjects(userId: string, organizationId: string): Promise<ProjectSummary[]> {
  const access = await requireOrgAccess(userId, { id: organizationId }, "project:read");
  return db.project.findMany({
    where: { organizationId: access.organizationId, archivedAt: null },
    select: projectSummarySelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function getProject(userId: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  const project = await db.project.findUniqueOrThrow({ where: { id: access.projectId }, select: projectSummarySelect });
  return { access, project };
}

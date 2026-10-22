import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { requireOrgAccess, requireProjectAccess } from "@/server/auth/authorization";
import { createOrganization, ensurePersonalOrganization, listOrganizationsForUser } from "@/server/organizations/service";
import { createProject, getProject, listProjects, updateProject } from "@/server/projects/service";
import { registerUser } from "@/server/auth/sign-up";
import { verifyPassword } from "@/server/auth/password";
import { AppError } from "@/lib/errors";

async function user(email: string) {
  return db.user.create({ data: { email, name: email.split("@")[0] } });
}

const projectInput = { name: "Acme", domain: "acme.com", country: "US", language: "en", timezone: "UTC" };

async function expectCode(promise: Promise<unknown>, code: AppError["code"]) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

describe("organization isolation", () => {
  it("users cannot read or modify another organization's projects", async () => {
    const alice = await user("alice@a.com");
    const mallory = await user("mallory@m.com");
    const aliceOrg = await createOrganization(alice.id, { name: "Alice Co" });
    await createOrganization(mallory.id, { name: "Mallory Co" });
    const project = await createProject(alice.id, aliceOrg.id, projectInput);

    await expectCode(requireOrgAccess(mallory.id, { id: aliceOrg.id }), "NOT_FOUND");
    await expectCode(requireOrgAccess(mallory.id, { slug: aliceOrg.slug }), "NOT_FOUND");
    await expectCode(requireProjectAccess(mallory.id, project.id), "NOT_FOUND");
    await expectCode(getProject(mallory.id, project.id), "NOT_FOUND");
    await expectCode(listProjects(mallory.id, aliceOrg.id), "NOT_FOUND");
    await expectCode(updateProject(mallory.id, project.id, { name: "pwned" }), "NOT_FOUND");
    await expectCode(createProject(mallory.id, aliceOrg.id, { ...projectInput, domain: "evil.com" }), "NOT_FOUND");

    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe("Acme");
    expect(await db.project.count({ where: { organizationId: aliceOrg.id } })).toBe(1);
  });

  it("enforces roles within an organization", async () => {
    const owner = await user("owner@a.com");
    const viewer = await user("viewer@a.com");
    const org = await createOrganization(owner.id, { name: "Roles Co" });
    await db.organizationMember.create({ data: { organizationId: org.id, userId: viewer.id, role: "VIEWER" } });
    const project = await createProject(owner.id, org.id, projectInput);

    await expect(getProject(viewer.id, project.id)).resolves.toBeTruthy();
    await expectCode(createProject(viewer.id, org.id, { ...projectInput, domain: "other.com" }), "FORBIDDEN");
    await expectCode(updateProject(viewer.id, project.id, { name: "x" }), "FORBIDDEN");
  });

  it("archived projects are not accessible", async () => {
    const owner = await user("arch@a.com");
    const org = await createOrganization(owner.id, { name: "Archive Co" });
    const project = await createProject(owner.id, org.id, projectInput);
    await db.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
    await expectCode(requireProjectAccess(owner.id, project.id), "NOT_FOUND");
  });
});

describe("organizations & projects", () => {
  it("creates an org with owner membership, FREE subscription, and audit log", async () => {
    const u = await user("o@a.com");
    const org = await createOrganization(u.id, { name: "Settings" });
    expect(org.slug).toBe("settings-team"); // reserved slug avoided
    const full = await db.organization.findUniqueOrThrow({ where: { id: org.id }, include: { members: true, subscription: true } });
    expect(full.members).toMatchObject([{ userId: u.id, role: "OWNER" }]);
    expect(full.subscription?.planTier).toBe("FREE");
    expect(await db.auditLog.count({ where: { organizationId: org.id, action: "organization.created" } })).toBe(1);
  });

  it("allocates unique slugs for duplicate names", async () => {
    const u = await user("dup@a.com");
    const a = await createOrganization(u.id, { name: "Acme" });
    const b = await createOrganization(u.id, { name: "Acme" });
    expect(a.slug).toBe("acme");
    expect(b.slug).not.toBe("acme");
    expect(b.slug.startsWith("acme-")).toBe(true);
  });

  it("ensurePersonalOrganization is idempotent", async () => {
    const u = await user("p@a.com");
    const first = await ensurePersonalOrganization(u.id, "Pat Smith");
    const second = await ensurePersonalOrganization(u.id, "Pat Smith");
    expect(first).toBe(second);
    const orgs = await listOrganizationsForUser(u.id);
    expect(orgs.map((o) => o.name)).toEqual(["Pat's workspace"]);
  });

  it("stores locale and rejects duplicate domains per org", async () => {
    const u = await user("d@a.com");
    const org = await createOrganization(u.id, { name: "Dupes" });
    const p = await createProject(u.id, org.id, { ...projectInput, country: "GB", domain: "https://www.acme.com" });
    expect(p).toMatchObject({ domain: "acme.com", country: "GB", locale: "en-GB" });
    await expectCode(createProject(u.id, org.id, { ...projectInput, domain: "acme.com" }), "CONFLICT");
  });
});

describe("project updates", () => {
  it("only changes the fields provided (regression: timezone was reset to UTC)", async () => {
    const u = await user("upd@a.com");
    const org = await createOrganization(u.id, { name: "Updates" });
    const p = await createProject(u.id, org.id, { ...projectInput, country: "DE", language: "de", timezone: "Europe/Berlin" });
    const updated = await updateProject(u.id, p.id, { name: "Renamed" });
    expect(updated).toMatchObject({ name: "Renamed", timezone: "Europe/Berlin", country: "DE", language: "de", locale: "de-DE" });
    const moved = await updateProject(u.id, p.id, { country: "AT" });
    expect(moved).toMatchObject({ country: "AT", language: "de", locale: "de-AT", timezone: "Europe/Berlin" });
  });
});

describe("registration", () => {
  it("creates a user with hashed password and a workspace; rejects duplicates", async () => {
    const created = await registerUser({ name: "Jo Doe", email: "JO@Example.com", password: "a-long-password" });
    const stored = await db.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.email).toBe("jo@example.com");
    expect(stored.passwordHash).not.toContain("a-long-password");
    expect(await verifyPassword("a-long-password", stored.passwordHash!)).toBe(true);
    expect(await db.organizationMember.count({ where: { userId: created.id, role: "OWNER" } })).toBe(1);
    await expectCode(registerUser({ name: "Jo", email: "jo@example.com", password: "another-password" }), "CONFLICT");
  });
});

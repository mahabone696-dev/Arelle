import { describe, expect, it } from "vitest";
import { can, isRoleAtLeast } from "@/server/auth/policy";

describe("authorization policy", () => {
  it("viewers can only read", () => {
    expect(can("VIEWER", "project:read")).toBe(true);
    expect(can("VIEWER", "org:read")).toBe(true);
    expect(can("VIEWER", "project:create")).toBe(false);
    expect(can("VIEWER", "scan:run")).toBe(false);
  });

  it("members can work on projects but not administer the org", () => {
    expect(can("MEMBER", "project:create")).toBe(true);
    expect(can("MEMBER", "scan:run")).toBe(true);
    expect(can("MEMBER", "project:delete")).toBe(false);
    expect(can("MEMBER", "members:manage")).toBe(false);
    expect(can("MEMBER", "billing:manage")).toBe(false);
  });

  it("admins manage members and projects but not billing or deletion of the org", () => {
    expect(can("ADMIN", "members:manage")).toBe(true);
    expect(can("ADMIN", "project:delete")).toBe(true);
    expect(can("ADMIN", "billing:manage")).toBe(false);
    expect(can("ADMIN", "org:delete")).toBe(false);
  });

  it("owners can do everything", () => {
    for (const p of ["org:delete", "billing:manage", "members:manage", "scan:run"] as const) {
      expect(can("OWNER", p)).toBe(true);
    }
  });

  it("ranks roles", () => {
    expect(isRoleAtLeast("OWNER", "ADMIN")).toBe(true);
    expect(isRoleAtLeast("MEMBER", "ADMIN")).toBe(false);
    expect(isRoleAtLeast("VIEWER", "VIEWER")).toBe(true);
  });
});

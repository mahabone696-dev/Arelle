import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { requireSessionUser } from "@/server/auth/session";
import { adminUsers } from "@/server/admin/service";
import { AdminTable, SearchBox, Td, when } from "../table";

export const metadata: Metadata = { title: "Users" };

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, user] = await Promise.all([searchParams, requireSessionUser()]);
  const rows = await adminUsers(user.id, q?.trim() || undefined);
  return (
    <>
      <SearchBox placeholder="Search email or name" q={q} />
      <AdminTable head={["User", "Organizations", "Joined"]} empty="No users match.">
        {rows.map((u) => (
          <tr key={u.id}>
            <Td>
              <div className="font-medium">
                {u.name ?? "—"} {u.isPlatformAdmin ? <Badge variant="outline">admin</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">{u.email}</div>
            </Td>
            <Td>
              {u.memberships.length
                ? u.memberships.map((m) => (
                    <div key={m.organization.slug} className="text-xs">
                      {m.organization.name} <span className="text-muted-foreground">· {m.role.toLowerCase()}</span>
                    </div>
                  ))
                : "—"}
            </Td>
            <Td className="whitespace-nowrap">{when(u.createdAt)}</Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}

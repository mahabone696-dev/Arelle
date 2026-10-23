import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/layout/user-menu";
import { requireSessionUser } from "@/server/auth/session";
import { requirePlatformAdmin } from "@/server/auth/authorization";
import { AdminNav } from "./admin-nav";

export const metadata: Metadata = { title: { template: "%s · Admin", default: "Admin" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Platform admins only; everyone else gets a 404 (the area's existence isn't revealed). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSessionUser();
  await requirePlatformAdmin(user.id).catch(() => notFound());
  return (
    <div className="min-h-dvh bg-sidebar">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link href="/">
            <Logo />
          </Link>
          <span className="rounded bg-foreground px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-background">Admin</span>
          <div className="ml-auto">
            <UserMenu {...user} />
          </div>
        </div>
        <div className="mx-auto max-w-6xl overflow-x-auto px-4">
          <AdminNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

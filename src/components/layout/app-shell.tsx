import Link from "next/link";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher, type OrgOption } from "./org-switcher";
import { ProjectSwitcher, type ProjectOption } from "./project-switcher";
import { DateRangePicker } from "./date-range-picker";
import { UserMenu } from "./user-menu";

interface ShellUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

/** Full product chrome: sidebar navigation + top bar with project and date range selectors. */
export function ProjectShell({
  user,
  orgs,
  orgSlug,
  projects,
  projectId,
  isDemo,
  children,
}: {
  user: ShellUser;
  orgs: OrgOption[];
  orgSlug: string;
  projects: ProjectOption[];
  projectId: string;
  isDemo: boolean;
  children: React.ReactNode;
}) {
  const basePath = `/${orgSlug}/p/${projectId}`;
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center px-4">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="px-2 pb-3">
          <OrgSwitcher orgs={orgs} currentSlug={orgSlug} />
        </div>
        <div className="flex-1 overflow-y-auto px-2">
          <Suspense>
            <SidebarNav basePath={basePath} />
          </Suspense>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 md:px-6">
            <Link href="/" className="md:hidden">
              <Logo className="[&>span]:hidden" />
            </Link>
            <ProjectSwitcher orgSlug={orgSlug} projects={projects} currentId={projectId} />
            {isDemo ? (
              <span className="shrink-0 whitespace-nowrap rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide">
                <span className="sm:hidden">Demo</span>
                <span className="hidden sm:inline">Demo data</span>
              </span>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Suspense>
                <DateRangePicker />
              </Suspense>
              <UserMenu {...user} />
            </div>
          </div>
          <div className="md:hidden">
            <Suspense>
              <SidebarNav basePath={basePath} orientation="horizontal" />
            </Suspense>
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

/** Minimal chrome for org-level pages (create project, create org). */
export function SimpleShell({ user, orgs, orgSlug, children }: { user: ShellUser; orgs: OrgOption[]; orgSlug?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-sidebar">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <Link href="/">
            <Logo />
          </Link>
          {orgs.length > 0 ? (
            <div className="w-56">
              <OrgSwitcher orgs={orgs} currentSlug={orgSlug} />
            </div>
          ) : null}
          <div className="ml-auto">
            <UserMenu {...user} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-10">{children}</main>
    </div>
  );
}

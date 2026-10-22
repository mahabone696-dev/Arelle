"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { PROJECT_NAV } from "./nav-items";

export function SidebarNav({ basePath, orientation = "vertical" }: { basePath: string; orientation?: "vertical" | "horizontal" }) {
  const pathname = usePathname();
  const range = useSearchParams().get("range");
  const query = range ? `?range=${range}` : "";
  return (
    <nav
      aria-label="Project"
      className={cn(orientation === "vertical" ? "grid gap-0.5" : "flex gap-1 overflow-x-auto px-4 pb-2 [scrollbar-width:none]")}
    >
      {PROJECT_NAV.map(({ segment, label, icon: Icon }) => {
        const href = segment ? `${basePath}/${segment}` : basePath;
        const active = segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === basePath;
        return (
          <Link
            key={label}
            href={`${href}${query}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

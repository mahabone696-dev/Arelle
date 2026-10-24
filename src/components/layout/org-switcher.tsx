"use client";

import Link from "next/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface OrgOption {
  slug: string;
  name: string;
  isDemo: boolean;
}

export function OrgSwitcher({ orgs, currentSlug }: { orgs: OrgOption[]; currentSlug?: string }) {
  const current = orgs.find((o) => o.slug === currentSlug);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className="flex size-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
          {(current?.name ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <span className="flex-1 truncate">{current?.name ?? "Select organization"}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs.map((org) => (
          <DropdownMenuItem key={org.slug} asChild>
            <Link href={`/${org.slug}`}>
              <span className="flex-1 truncate">{org.name}</span>
              {org.isDemo ? <span className="text-[10px] uppercase text-muted-foreground">Demo</span> : null}
              {org.slug === currentSlug ? <Check /> : null}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/orgs/new">
            <Plus /> New organization
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

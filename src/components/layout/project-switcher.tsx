"use client";

import Link from "next/link";
import { Check, ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ProjectOption {
  id: string;
  name: string;
  domain: string;
}

export function ProjectSwitcher({ orgSlug, projects, currentId }: { orgSlug: string; projects: ProjectOption[]; currentId?: string }) {
  const current = projects.find((p) => p.id === currentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <span className="truncate font-medium">{current?.name ?? "Select project"}</span>
        {current ? <span className="hidden truncate text-muted-foreground sm:inline">{current.domain}</span> : null}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        {projects.map((p) => (
          <DropdownMenuItem key={p.id} asChild>
            <Link href={`/${orgSlug}/p/${p.id}`}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{p.name}</span>
                <span className="truncate text-xs text-muted-foreground">{p.domain}</span>
              </span>
              {p.id === currentId ? <Check /> : null}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={`/${orgSlug}/onboarding`}>
            <Plus /> New project
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

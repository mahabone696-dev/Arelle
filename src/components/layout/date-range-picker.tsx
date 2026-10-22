"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { DATE_RANGES, parseDateRange } from "@/lib/date-range";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function DateRangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = parseDateRange(params.get("range") ?? undefined);
  const label = DATE_RANGES.find((r) => r.key === current)!.label;

  const select = (key: string) => {
    const next = new URLSearchParams(params);
    next.set("range", key);
    router.push(`${pathname}?${next.toString()}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        <CalendarDays className="size-3.5 text-muted-foreground" />
        <span className="hidden sm:inline">{label}</span>
        <span className="sm:hidden">{current}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {DATE_RANGES.map((r) => (
          <DropdownMenuItem key={r.key} onSelect={() => select(r.key)}>
            <span className="flex-1">{r.label}</span>
            {r.key === current ? <Check /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown where a feature isn't in the organization's plan. The server enforces the same gate. */
export function UpgradeCard({ orgSlug, title, description, compact = false }: { orgSlug: string; title: string; description: string; compact?: boolean }) {
  return (
    <div className={compact ? "flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2.5 text-[13px]" : "grid justify-items-center gap-3 rounded-lg border border-dashed bg-card px-6 py-10 text-center"}>
      <Sparkles className={compact ? "size-4 text-muted-foreground" : "size-6 text-muted-foreground"} aria-hidden />
      <div className={compact ? "min-w-0 flex-1" : "grid max-w-md gap-1"}>
        <div className="text-sm font-medium">{title}</div>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>
      <Button asChild size="sm" variant={compact ? "outline" : "default"}>
        <Link href={`/${orgSlug}/billing`}>See plans</Link>
      </Button>
    </div>
  );
}

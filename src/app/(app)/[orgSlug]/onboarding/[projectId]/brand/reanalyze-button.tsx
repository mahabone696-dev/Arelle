"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";

export function ReanalyzeButton({ action, variant = "outline", label = "Try again" }: { action: () => Promise<ActionResult>; variant?: "outline" | "ghost"; label?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={pending}
        className={variant === "ghost" ? "justify-start px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" : undefined}
        onClick={() =>
          start(async () => {
            const res = await action();
            setError(res.ok ? null : res.error);
          })
        }
      >
        <RefreshCw className={pending ? "animate-spin" : undefined} />
        {pending ? "Analyzing…" : label}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

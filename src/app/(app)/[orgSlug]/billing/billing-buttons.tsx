"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";

/** Calls a server action that redirects to Stripe; shows its error if it doesn't. */
export function StripeButton({ action, children, variant = "default", disabled }: { action: () => Promise<ActionResult>; children: React.ReactNode; variant?: "default" | "outline"; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1.5">
      <Button
        size="sm"
        variant={variant}
        disabled={disabled || pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await action();
            if (res && !res.ok) setError(res.error);
          })
        }
      >
        {pending ? "Opening Stripe…" : children}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

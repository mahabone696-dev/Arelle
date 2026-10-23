"use client";

import { useActionState, useState, useTransition } from "react";
import { CheckCircle2, CalendarClock, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/form-field";
import type { ActionResult } from "@/lib/errors";

type Status = "OPEN" | "PLANNED" | "IMPLEMENTED" | "DISMISSED";

export function RecommendationControls({
  status,
  canEdit,
  defaultUrl,
  plan,
  setStatus,
  implement,
}: {
  status: Status;
  canEdit: boolean;
  defaultUrl: string | null;
  plan: () => Promise<ActionResult>;
  setStatus: (s: "OPEN" | "DISMISSED") => Promise<ActionResult>;
  implement: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [state, formAction, submitting] = useActionState(implement, null);

  if (!canEdit) return <p className="text-[13px] text-muted-foreground">You have view-only access to this project.</p>;
  if (status === "IMPLEMENTED") return null;

  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
    });

  const today = new Date().toISOString().slice(0, 10);
  const v = state && !state.ok ? state.values : undefined;

  return (
    <div className="grid gap-3">
      {status === "DISMISSED" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setStatus("OPEN"))}>
            <RotateCcw /> Restore
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {status === "OPEN" ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(plan)}>
              <CalendarClock /> Mark as planned
            </Button>
          ) : null}
          <Button size="sm" disabled={pending} onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
            <CheckCircle2 /> Mark as implemented
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setStatus("DISMISSED"))}>
            <X /> Dismiss
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {showForm && status !== "DISMISSED" ? (
        <form action={formAction} className="grid gap-3 rounded-md border bg-muted/30 p-4">
          <div className="grid gap-3">
            <FormField id="implementedAt" label="Implemented on" error={state && !state.ok ? state.fieldErrors?.implementedAt?.[0] : undefined}>
              <Input id="implementedAt" name="implementedAt" type="date" required max={today} defaultValue={v?.implementedAt || today} />
            </FormField>
            <FormField id="implementationUrl" label="URL (optional)" hint="Where the change is live." error={state && !state.ok ? state.fieldErrors?.implementationUrl?.[0] : undefined}>
              <Input id="implementationUrl" name="implementationUrl" type="url" inputMode="url" placeholder="https://" defaultValue={v?.implementationUrl ?? defaultUrl ?? ""} />
            </FormField>
          </div>
          <FormField id="notes" label="Notes (optional)">
            <Textarea id="notes" name="notes" maxLength={2000} rows={3} defaultValue={v?.notes ?? ""} placeholder="What changed?" />
          </FormField>
          {state && !state.ok && !state.fieldErrors ? (
            <p role="alert" className="text-[13px] text-destructive">
              {state.error}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">We&apos;ll record your visibility for this topic over the 30 days before this date, then show the observed change after each later scan.</p>
          <div>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "Saving…" : "Save as implemented"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

export function OpportunityStatusButton({ status, canEdit, setStatus }: { status: "OPEN" | "DISMISSED" | "RESOLVED"; canEdit: boolean; setStatus: (s: "OPEN" | "DISMISSED") => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!canEdit || status === "RESOLVED") return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await setStatus(status === "OPEN" ? "DISMISSED" : "OPEN");
            setError(res.ok ? null : res.error);
          })
        }
      >
        {status === "OPEN" ? (
          <>
            <X /> Dismiss
          </>
        ) : (
          <>
            <RotateCcw /> Restore
          </>
        )}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

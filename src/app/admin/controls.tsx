"use client";

import { useActionState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/errors";

export function KillSwitchForm({ enabled, action: serverAction }: { enabled: boolean; action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult> }) {
  const [state, action, pending] = useActionState(serverAction, null);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!enabled && !confirm("Pause all new scan dispatches and public audits?")) e.preventDefault();
      }}
      className="grid gap-2"
    >
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      {!enabled ? <Input name="reason" placeholder="Reason (e.g. provider incident)" maxLength={200} required aria-label="Reason" defaultValue={state && !state.ok ? state.values?.reason : undefined} /> : null}
      <Button type="submit" variant={enabled ? "default" : "destructive"} disabled={pending} className="justify-self-start">
        {pending ? "Saving…" : enabled ? "Resume scans" : "Pause all scans"}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function ProviderToggle({ enabled, name, toggle }: { enabled: boolean; name: string; toggle: () => Promise<void> }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => {
        if (enabled && !confirm(`Disable ${name}? New scans will skip it.`)) return;
        start(() => toggle());
      }}
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </Button>
  );
}

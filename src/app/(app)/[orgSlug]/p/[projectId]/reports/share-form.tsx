"use client";

import { useActionState, useState, useTransition } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FormField } from "@/components/ui/form-field";
import type { ActionResult } from "@/lib/errors";

export function ShareForm({ action }: { action: (prev: ActionResult<{ url: string }> | null, form: FormData) => Promise<ActionResult<{ url: string }>> }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [copied, setCopied] = useState(false);
  const v = state && !state.ok ? state.values : undefined;
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k]?.[0] : undefined);
  return (
    <div className="grid gap-4">
      <form action={formAction} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField id="title" label="Title (optional)" error={err("title")}>
            <Input id="title" name="title" maxLength={120} defaultValue={v?.title} placeholder="Monthly AI visibility report" />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="range" label="Period">
              <NativeSelect id="range" name="range" defaultValue={v?.range || "30d"}>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </NativeSelect>
            </FormField>
            <FormField id="expiresInDays" label="Link expires">
              <NativeSelect id="expiresInDays" name="expiresInDays" defaultValue={v?.expiresInDays || "30"}>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="0">Never</option>
              </NativeSelect>
            </FormField>
          </div>
          <FormField id="agencyName" label="Prepared by (optional)" hint="Your agency's name, shown at the top of the report." error={err("agencyName")}>
            <Input id="agencyName" name="agencyName" maxLength={80} defaultValue={v?.agencyName} />
          </FormField>
          <FormField id="accentColor" label="Accent colour (optional)" hint="Hex, e.g. #2a78d6" error={err("accentColor")}>
            <Input id="accentColor" name="accentColor" maxLength={7} defaultValue={v?.accentColor} placeholder="#2a78d6" />
          </FormField>
        </div>
        {state && !state.ok && !state.fieldErrors ? (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create share link"}
          </Button>
        </div>
      </form>
      {state?.ok ? (
        <div className="grid gap-2 rounded-md border border-success/40 bg-success/5 p-3 text-[13px]">
          <div className="font-medium">Link created — copy it now, it won&apos;t be shown again.</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1.5 text-xs">{state.data.url}</code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard?.writeText(state.data.url).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Anyone with the link can view this project&apos;s report (read-only) until it expires or you turn it off.</p>
        </div>
      ) : null}
    </div>
  );
}

export function RevokeButton({ revoke }: { revoke: () => Promise<ActionResult> }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await revoke()))}>
      {pending ? "Turning off…" : "Turn off"}
    </Button>
  );
}

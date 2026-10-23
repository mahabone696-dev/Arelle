"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { COUNTRIES } from "@/lib/i18n";
import type { ActionResult } from "@/lib/errors";

export function AuditForm({ action: serverAction, formToken }: { action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>; formToken: string }) {
  const [state, action, pending] = useActionState(serverAction, null);
  const values = state && !state.ok ? state.values : undefined;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="formToken" value={formToken} />
      {/* Honeypot: hidden from people and assistive tech; bots tend to fill it. */}
      <div aria-hidden className="absolute -left-[9999px] size-px overflow-hidden">
        <label>
          Leave this empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      <Label htmlFor="domain" className="sr-only">
        Your website
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="domain"
          name="domain"
          inputMode="url"
          autoComplete="url"
          placeholder="yourcompany.com"
          required
          maxLength={2048}
          defaultValue={values?.domain}
          className="h-11 text-base"
          aria-invalid={!!(state && !state.ok)}
          aria-describedby={state && !state.ok ? "audit-error" : undefined}
        />
        <Button type="submit" size="lg" className="h-11" disabled={pending}>
          {pending ? "Starting…" : "Run free audit"}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Label htmlFor="country" className="font-normal">
          Market
        </Label>
        <NativeSelect id="country" name="country" defaultValue={values?.country ?? "US"} key={values?.country} className="h-8 w-auto text-[13px]">
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {state && !state.ok ? (
        <p id="audit-error" role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

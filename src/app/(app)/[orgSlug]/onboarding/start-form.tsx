"use client";

import { useActionState, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { COUNTRIES, LANGUAGES } from "@/lib/i18n";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";

const PROGRESS = ["Checking robots.txt", "Reading your homepage", "Scanning the sitemap", "Reading key pages", "Building your brand profile"];

/** Indicative progress while the analysis request runs; the server does the real work. */
function AnalysisProgress() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, PROGRESS.length - 1)), 2500);
    return () => clearInterval(t);
  }, []);
  return (
    <ul className="mt-6 grid gap-2 text-sm" aria-live="polite">
      {PROGRESS.map((label, i) => (
        <li key={label} className={cn("flex items-center gap-2.5", i > step && "text-muted-foreground/60")}>
          {i < step ? <Check className="size-4 text-success" /> : i === step ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <span className="size-4" />}
          {label}
        </li>
      ))}
    </ul>
  );
}

export function StartForm({ action: serverAction }: { action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult> }) {
  const [state, action, pending] = useActionState(serverAction, null);
  const values = state && !state.ok ? state.values : undefined;
  const tz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  return (
    <form action={action}>
      <Label htmlFor="url" className="sr-only">
        Website
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="url"
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          placeholder="https://example.com"
          required
          autoFocus
          defaultValue={values?.url}
          className="h-11 text-base"
          aria-invalid={!!(state && !state.ok)}
          aria-describedby={state && !state.ok ? "url-error" : undefined}
        />
        <Button type="submit" size="lg" className="h-11" disabled={pending}>
          {pending ? "Analyzing…" : "Analyze Website"}
        </Button>
      </div>
      <input type="hidden" name="timezone" value={values?.timezone ?? tz} suppressHydrationWarning />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-sm">
        <div className="grid gap-1.5">
          <Label htmlFor="country" className="text-xs text-muted-foreground">
            Market
          </Label>
          <NativeSelect id="country" name="country" defaultValue={values?.country ?? "US"} key={`c-${values?.country}`} className="h-8 text-[13px]">
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="language" className="text-xs text-muted-foreground">
            Language
          </Label>
          <NativeSelect id="language" name="language" defaultValue={values?.language ?? "en"} key={`l-${values?.language}`} className="h-8 text-[13px]">
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {state && !state.ok ? (
        <p id="url-error" role="alert" className="mt-3 text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
      {pending ? <AnalysisProgress /> : null}
    </form>
  );
}

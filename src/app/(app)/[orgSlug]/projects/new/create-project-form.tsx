"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FormField } from "@/components/ui/form-field";
import { COUNTRIES, LANGUAGES } from "@/lib/i18n";
import type { ActionResult } from "@/lib/errors";

export function CreateProjectForm({ action: serverAction }: { action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult> }) {
  const [state, action, pending] = useActionState(serverAction, null);
  const err = (name: string) => (state && !state.ok ? state.fieldErrors?.[name]?.[0] : undefined);
  const values = state && !state.ok ? state.values : undefined;
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";

  return (
    <form action={action} className="grid gap-5">
      <FormField id="domain" label="Website" hint="The primary domain of the brand, e.g. example.com" error={err("domain")}>
        <Input id="domain" name="domain" placeholder="https://example.com" required defaultValue={values?.domain} aria-invalid={!!err("domain")} />
      </FormField>
      <FormField id="name" label="Project name" error={err("name")}>
        <Input id="name" name="name" placeholder="Example Inc." required defaultValue={values?.name} aria-invalid={!!err("name")} />
      </FormField>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="country" label="Primary market" error={err("country")}>
          <NativeSelect id="country" name="country" defaultValue={values?.country ?? "US"} key={`c-${values?.country}`}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="language" label="Language" error={err("language")}>
          <NativeSelect id="language" name="language" defaultValue={values?.language ?? "en"} key={`l-${values?.language}`}>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <FormField id="timezone" label="Timezone" hint="Used for scan schedules and daily reporting." error={err("timezone")}>
        <Input id="timezone" name="timezone" defaultValue={values?.timezone ?? browserTz} required aria-invalid={!!err("timezone")} suppressHydrationWarning />
      </FormField>
      {state && !state.ok && !state.fieldErrors ? (
        <p role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

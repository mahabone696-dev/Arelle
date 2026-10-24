"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { createOrganizationAction } from "./actions";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, null);
  const error = state && !state.ok ? (state.fieldErrors?.name?.[0] ?? state.error) : undefined;
  return (
    <form action={action} className="grid gap-4">
      <FormField id="name" label="Organization name" hint="Your company or agency name." error={error}>
        <Input id="name" name="name" defaultValue={state && !state.ok ? state.values?.name : undefined} required minLength={2} maxLength={80} aria-invalid={!!error} />
      </FormField>
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}

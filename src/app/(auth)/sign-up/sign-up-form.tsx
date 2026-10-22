"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { signUpAction } from "../actions";

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUpAction, null);
  const fieldError = (name: string) => (state && !state.ok ? state.fieldErrors?.[name]?.[0] : undefined);
  const values = state && !state.ok ? state.values : undefined;
  return (
    <form action={action} className="grid gap-4">
      <FormField id="name" label="Name" error={fieldError("name")}>
        <Input id="name" name="name" autoComplete="name" required defaultValue={values?.name} aria-invalid={!!fieldError("name")} />
      </FormField>
      <FormField id="email" label="Work email" error={fieldError("email")}>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={values?.email} aria-invalid={!!fieldError("email")} />
      </FormField>
      <FormField id="password" label="Password" hint="At least 10 characters." error={fieldError("password")}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required aria-invalid={!!fieldError("password")} />
      </FormField>
      {state && !state.ok && !state.fieldErrors ? (
        <p role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { signInAction } from "../actions";

export function SignInForm({ callbackUrl }: { callbackUrl?: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  const values = state && !state.ok ? state.values : undefined;
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl ?? "/"} />
      <FormField id="email" label="Email">
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={values?.email} />
      </FormField>
      <FormField id="password" label="Password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </FormField>
      {state && !state.ok ? (
        <p role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

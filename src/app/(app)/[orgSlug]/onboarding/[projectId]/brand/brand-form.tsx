"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TagInput } from "@/components/ui/tag-input";
import { FormField } from "@/components/ui/form-field";
import type { ActionResult } from "@/lib/errors";

export interface BrandDefaults {
  brandName: string;
  industry: string;
  description: string;
  products: string[];
  services: string[];
  targetCustomers: string[];
  markets: string[];
  topics: string[];
  aliases: string[];
}

export function BrandForm({ action: serverAction, defaults }: { action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>; defaults: BrandDefaults }) {
  const [state, action, pending] = useActionState(serverAction, null);
  const err = (k: string) => (state && !state.ok ? state.fieldErrors?.[k]?.[0] : undefined);
  const v = state && !state.ok ? state.values : undefined;
  const list = (k: keyof BrandDefaults) => {
    if (v?.[k]) {
      try {
        return JSON.parse(v[k]) as string[];
      } catch {
        /* fall through */
      }
    }
    return defaults[k] as string[];
  };
  // Re-mount tag inputs after a failed submit so they show the submitted values.
  const k = state && !state.ok ? "r" : "d";

  return (
    <form action={action} className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="brandName" label="Brand" error={err("brandName")}>
          <Input id="brandName" name="brandName" defaultValue={v?.brandName ?? defaults.brandName} required maxLength={80} aria-invalid={!!err("brandName")} />
        </FormField>
        <FormField id="industry" label="Industry / category" hint="How buyers describe what you sell." error={err("industry")}>
          <Input id="industry" name="industry" defaultValue={v?.industry ?? defaults.industry} placeholder="e.g. CRM software" required maxLength={120} aria-invalid={!!err("industry")} />
        </FormField>
      </div>
      <FormField id="description" label="Description" error={err("description")}>
        <Textarea id="description" name="description" defaultValue={v?.description ?? defaults.description} maxLength={600} rows={3} />
      </FormField>
      <FormField id="products" label="Products" hint="Press Enter to add.">
        <TagInput key={`products-${k}`} id="products" name="products" defaultValue={list("products")} placeholder="Add a product" max={12} />
      </FormField>
      <FormField id="services" label="Services">
        <TagInput key={`services-${k}`} id="services" name="services" defaultValue={list("services")} placeholder="Add a service" max={12} />
      </FormField>
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="targetCustomers" label="Target customers">
          <TagInput key={`tc-${k}`} id="targetCustomers" name="targetCustomers" defaultValue={list("targetCustomers")} placeholder="e.g. startups" max={10} />
        </FormField>
        <FormField id="markets" label="Target markets">
          <TagInput key={`markets-${k}`} id="markets" name="markets" defaultValue={list("markets")} placeholder="e.g. United States" max={10} />
        </FormField>
      </div>
      <FormField id="topics" label="Topics" hint="Themes you want to be found for in AI answers.">
        <TagInput key={`topics-${k}`} id="topics" name="topics" defaultValue={list("topics")} placeholder="Add a topic" max={15} />
      </FormField>
      <FormField id="aliases" label="Other names" hint="Alternate spellings or product names AI might use for your brand.">
        <TagInput key={`aliases-${k}`} id="aliases" name="aliases" defaultValue={list("aliases")} placeholder="e.g. Acme CRM" max={10} />
      </FormField>
      {state && !state.ok && !state.fieldErrors ? (
        <p role="alert" className="text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex items-center gap-3 border-t pt-5">
        <Button type="submit" disabled={pending}>
          {pending ? "Finding competitors…" : "Continue to competitors"}
        </Button>
      </div>
    </form>
  );
}

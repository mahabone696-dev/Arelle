"use client";

import { useActionState, useState, useTransition } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import type { ActionResult } from "@/lib/errors";

interface Item {
  key: string;
  id?: string;
  name: string;
  domain: string;
  reason?: string;
  source?: string;
}

const MAX = 10;
let seq = 0;
const newKey = () => `new-${++seq}`;

function CompetitorCard({ item, onChange, onRemove }: { item: Item; onChange: (i: Item) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(!item.name);
  return (
    <Card className="flex flex-col gap-3 p-4">
      {editing ? (
        <div className="grid gap-2">
          <Input aria-label="Competitor name" value={item.name} placeholder="Competitor name" autoFocus onChange={(e) => onChange({ ...item, name: e.target.value })} maxLength={80} />
          <Input aria-label="Competitor domain" value={item.domain} placeholder="competitor.com" onChange={(e) => onChange({ ...item, domain: e.target.value })} maxLength={253} />
          <Button type="button" size="sm" variant="secondary" disabled={!item.name.trim()} onClick={() => setEditing(false)} className="justify-self-start">
            Done
          </Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{item.name}</div>
            <div className="truncate text-[13px] text-muted-foreground">{item.domain || "No domain"}</div>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Edit ${item.name}`} onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Remove ${item.name}`} onClick={onRemove}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
      {item.reason && !editing ? <p className="text-[13px] leading-relaxed text-muted-foreground">{item.reason}</p> : null}
      {item.source === "AI_SUGGESTED" && !editing ? <Badge variant="outline" className="self-start">Suggested</Badge> : null}
    </Card>
  );
}

export function CompetitorsEditor({
  initial,
  aiAvailable,
  save,
  regenerate,
}: {
  initial: Omit<Item, "key">[];
  aiAvailable: boolean;
  save: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  regenerate: () => Promise<ActionResult<{ method: string }>>;
}) {
  const [items, setItems] = useState<Item[]>(() => initial.map((c) => ({ ...c, key: c.id ?? newKey() })));
  const [state, action, pending] = useActionState(save, null);
  const [regenerating, startRegen] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);

  const update = (key: string, next: Item) => setItems((xs) => xs.map((x) => (x.key === key ? next : x)));
  const payload = JSON.stringify(items.filter((i) => i.name.trim()).map(({ id, name, domain }) => ({ id, name: name.trim(), domain: domain.trim() })));

  return (
    <form action={action}>
      <input type="hidden" name="payload" value={payload} />
      {items.length === 0 ? (
        <EmptyState
          title="No competitors yet"
          description={aiAvailable ? "We couldn't suggest competitors automatically. Add the brands buyers compare you with." : "AI suggestions aren't configured. Add the brands buyers compare you with."}
          className="bg-background"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <CompetitorCard key={item.key} item={item} onChange={(n) => update(item.key, n)} onRemove={() => setItems((xs) => xs.filter((x) => x.key !== item.key))} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={items.length >= MAX} onClick={() => setItems((xs) => [...xs, { key: newKey(), name: "", domain: "" }])}>
          <Plus /> Add competitor
        </Button>
        {aiAvailable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={regenerating}
            onClick={() => {
              if (items.some((i) => i.source === "USER" || !i.id) && !confirm("Replace suggestions? Competitors you added yourself are kept.")) return;
              startRegen(async () => {
                const res = await regenerate();
                setRegenError(res.ok ? (res.data.method === "UNAVAILABLE" ? "AI suggestions are unavailable right now." : null) : res.error);
              });
            }}
          >
            <RefreshCw className={regenerating ? "animate-spin" : undefined} />
            {regenerating ? "Suggesting…" : "Suggest again"}
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {items.length} / {MAX}
        </span>
      </div>

      {regenError ? <p className="mt-3 text-[13px] text-destructive">{regenError}</p> : null}
      {state && !state.ok ? (
        <p role="alert" className="mt-3 text-[13px] text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="mt-8 flex items-center gap-3 border-t pt-5">
        <Button type="submit" disabled={pending || items.some((i) => !i.name.trim())}>
          {pending ? "Generating prompts…" : "Continue to prompts"}
        </Button>
        {pending ? <span className="text-[13px] text-muted-foreground">Writing 30 prompts for your market — this can take a moment.</span> : null}
      </div>
    </form>
  );
}

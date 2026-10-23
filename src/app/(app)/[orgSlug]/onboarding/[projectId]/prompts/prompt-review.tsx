"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { INTENT_LABELS, PROMPT_INTENTS } from "@/lib/prompt-intents";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";

type Intent = (typeof PROMPT_INTENTS)[number];

interface Row {
  key: string;
  id?: string;
  text: string;
  intent: Intent;
  cluster: string;
  priority: number;
  reason: string;
  source: string;
  approved: boolean;
}

let seq = 0;

const selectCls = "h-8 rounded-md border border-input bg-card px-2 text-[13px] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";

export function PromptReview({
  initial,
  completed,
  justSaved,
  promptLimit,
  planName,
  save,
  regenerate,
}: {
  initial: Omit<Row, "key">[];
  completed: boolean;
  justSaved: boolean;
  promptLimit: number;
  planName: string;
  save: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  regenerate: () => Promise<ActionResult>;
}) {
  const [rows, setRows] = useState<Row[]>(() => initial.map((r) => ({ ...r, key: r.id! })));
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<Intent | "ALL">("ALL");
  const [state, action, pending] = useActionState(save, null);
  const [regenerating, startRegen] = useTransition();
  const [regenError, setRegenError] = useState<string | null>(null);

  const counts = useMemo(() => Object.fromEntries(PROMPT_INTENTS.map((i) => [i, rows.filter((r) => r.intent === i).length])) as Record<Intent, number>, [rows]);
  const clusters = useMemo(() => [...new Set(rows.map((r) => r.cluster))].sort(), [rows]);
  const visible = filter === "ALL" ? rows : rows.filter((r) => r.intent === filter);
  const approvedCount = rows.filter((r) => r.approved).length;

  const update = (key: string, patch: Partial<Row>) => setRows((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const remove = (row: Row) => {
    setRows((xs) => xs.filter((x) => x.key !== row.key));
    if (row.id) setDeletedIds((d) => [...d, row.id!]);
  };
  const addRow = () => {
    const intent = filter === "ALL" ? "COMMERCIAL" : filter;
    setRows((xs) => [{ key: `new-${++seq}`, text: "", intent, cluster: clusters[0] ?? "General", priority: 3, reason: "", source: "USER", approved: true }, ...xs]);
  };
  const setAll = (approved: boolean) => setRows((xs) => xs.map((x) => (filter === "ALL" || x.intent === filter ? { ...x, approved } : x)));

  const payload = JSON.stringify({
    prompts: rows.map(({ id, text, intent, cluster, priority, approved }) => ({ id, text: text.trim(), intent, cluster: cluster.trim() || "General", priority, approved })),
    deletedIds,
  });
  const invalid = rows.some((r) => r.text.trim().length < 3);
  const overLimit = approvedCount > promptLimit;

  return (
    <form action={action}>
      <input type="hidden" name="payload" value={payload} />
      <datalist id="clusters">
        {clusters.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filter by intent">
        {(["ALL", ...PROMPT_INTENTS] as const).map((i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={filter === i}
            onClick={() => setFilter(i)}
            className={cn("rounded-md px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-accent", filter === i && "bg-accent font-medium text-foreground")}
            title={i === "ALL" ? undefined : INTENT_LABELS[i].hint}
          >
            {i === "ALL" ? "All" : INTENT_LABELS[i].label} <span className="tabular text-muted-foreground">{i === "ALL" ? rows.length : counts[i]}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setAll(true)}>
            Approve all
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAll(false)}>
            Clear
          </Button>
        </div>
      </div>

      <Card className="mt-3 overflow-hidden">
        {visible.length === 0 ? (
          <EmptyState title="No prompts here" description="Add a prompt or generate suggestions." className="m-4" />
        ) : (
          <ul className="divide-y">
            {visible.map((r) => (
              <li key={r.key} className={cn("grid gap-2 px-4 py-3 md:grid-cols-[auto_1fr_auto] md:items-start", !r.approved && "bg-muted/40")}>
                <input
                  type="checkbox"
                  checked={r.approved}
                  onChange={(e) => update(r.key, { approved: e.target.checked })}
                  aria-label={`Approve “${r.text}”`}
                  className="mt-2 size-4 accent-[var(--primary)]"
                />
                <div className="min-w-0">
                  <Input
                    value={r.text}
                    onChange={(e) => update(r.key, { text: e.target.value })}
                    aria-label="Prompt text"
                    placeholder="Write a prompt buyers would ask"
                    maxLength={200}
                    autoFocus={!r.id && !r.text}
                    aria-invalid={r.text.trim().length < 3}
                    className="h-8 border-transparent bg-transparent px-1.5 font-medium shadow-none hover:border-input focus-visible:bg-card"
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 text-xs text-muted-foreground">
                    {r.reason ? <span className="min-w-0 flex-1 basis-64">{r.reason}</span> : null}
                    {r.source === "TEMPLATE" ? <Badge variant="warning">Template</Badge> : null}
                    {r.source === "USER" && !r.id ? <Badge variant="outline">New</Badge> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 md:justify-end">
                  <select aria-label="Intent" value={r.intent} onChange={(e) => update(r.key, { intent: e.target.value as Intent })} className={selectCls}>
                    {PROMPT_INTENTS.map((i) => (
                      <option key={i} value={i}>
                        {INTENT_LABELS[i].label}
                      </option>
                    ))}
                  </select>
                  <input aria-label="Cluster" list="clusters" value={r.cluster} maxLength={60} onChange={(e) => update(r.key, { cluster: e.target.value })} className={cn(selectCls, "w-36")} />
                  <select aria-label="Priority" value={r.priority} onChange={(e) => update(r.key, { priority: Number(e.target.value) })} className={selectCls} title="Priority (5 = highest commercial value)">
                    {[5, 4, 3, 2, 1].map((p) => (
                      <option key={p} value={p}>
                        P{p}
                      </option>
                    ))}
                  </select>
                  <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="Delete prompt" onClick={() => remove(r)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={addRow} disabled={rows.length >= 200}>
          <Plus /> Add prompt
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={regenerating}
          onClick={() => {
            if (!confirm("Replace all prompts that haven't been approved yet with new suggestions?")) return;
            startRegen(async () => {
              const res = await regenerate();
              setRegenError(res.ok ? null : res.error);
            });
          }}
        >
          <RefreshCw className={regenerating ? "animate-spin" : undefined} />
          {regenerating ? "Generating…" : "Regenerate suggestions"}
        </Button>
        {regenError ? <span className="text-[13px] text-destructive">{regenError}</span> : null}
      </div>

      <div className="sticky bottom-0 -mx-4 mt-8 border-t bg-sidebar/95 px-4 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular text-sm">
            <span className={cn("font-medium", overLimit && "text-destructive")}>{approvedCount}</span> <span className="text-muted-foreground">of {rows.length} approved · {planName} plan tracks up to {promptLimit}</span>
          </span>
          {overLimit ? <span className="text-[13px] text-destructive">Un-approve {approvedCount - promptLimit} to continue, or upgrade your plan.</span> : null}
          {state && !state.ok ? (
            <span role="alert" className="text-[13px] text-destructive">
              {state.error}
            </span>
          ) : justSaved && !state ? (
            <span className="text-[13px] text-success">Saved</span>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button type="submit" name="intent" value="save" variant="outline" disabled={pending || invalid || overLimit}>
              Save draft
            </Button>
            <Button type="submit" name="intent" value="finish" disabled={pending || invalid || approvedCount === 0 || overLimit}>
              {pending ? "Saving…" : completed ? "Save prompts" : `Approve ${approvedCount} prompts & finish`}
            </Button>
          </div>
        </div>
        {!completed ? <p className="mt-2 text-xs text-muted-foreground">Next: run your first scan to see where your brand appears in AI answers.</p> : null}
      </div>
    </form>
  );
}

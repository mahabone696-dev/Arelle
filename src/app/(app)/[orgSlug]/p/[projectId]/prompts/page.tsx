import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquareText, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FilterForm } from "@/components/dashboard/filter-form";
import { Delta, num1 } from "@/components/dashboard/delta";
import { PROMPT_STATUSES, PromptStatusBadge, statusLabel } from "@/components/dashboard/prompt-status";
import { getProjectPage } from "@/server/auth/session";
import { getPromptsTable, type PromptFilters } from "@/server/dashboard/metrics";
import type { PromptStatus } from "@/server/dashboard/aggregate";
import { INTENT_LABELS, PROMPT_INTENTS } from "@/lib/prompt-intents";
import { parseDateRange } from "@/lib/date-range";
import { countryName, languageName } from "@/lib/i18n";
import type { PromptIntent } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Prompts" };

const selectCls = "h-8 rounded-md border border-input bg-card px-2 text-[13px] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20";
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]) => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

export default async function PromptsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ orgSlug, projectId }, sp] = await Promise.all([params, searchParams]);
  const { user } = await getProjectPage(orgSlug, projectId);
  const range = parseDateRange(sp.range);
  const [country, language] = (sp.market ?? "").split("-");
  const filters: PromptFilters = {
    q: sp.q?.trim().slice(0, 100) || undefined,
    intent: pick<PromptIntent>(sp.intent, PROMPT_INTENTS),
    status: pick<PromptStatus>(sp.status, PROMPT_STATUSES),
    providerId: sp.engine || undefined,
    country: country || undefined,
    language: language || undefined,
  };
  const { rows, providers, allProviders, markets } = await getPromptsTable(user.id, projectId, range, filters);
  const base = `/${orgSlug}/p/${projectId}`;
  const filtered = Object.values(filters).some(Boolean);
  const edit = (
    <Button asChild variant="outline" size="sm">
      <Link href={`/${orgSlug}/onboarding/${projectId}/prompts`}>Edit prompts</Link>
    </Button>
  );

  return (
    <>
      <PageHeader title="Prompts" description="How each tracked question performs in AI answers." actions={edit} />
      <FilterForm className="mb-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="range" value={range} />
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={filters.q} placeholder="Search prompts" aria-label="Search prompts" className="h-8 pl-8 text-[13px]" />
        </div>
        <select name="intent" defaultValue={filters.intent ?? ""} aria-label="Intent" className={selectCls}>
          <option value="">All intents</option>
          {PROMPT_INTENTS.map((i) => (
            <option key={i} value={i}>
              {INTENT_LABELS[i].label}
            </option>
          ))}
        </select>
        <select name="engine" defaultValue={filters.providerId ?? ""} aria-label="AI engine" className={selectCls}>
          <option value="">All engines</option>
          {allProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filters.status ?? ""} aria-label="Visibility status" className={selectCls}>
          <option value="">Any status</option>
          {PROMPT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        {markets.length > 1 ? (
          <select name="market" defaultValue={sp.market ?? ""} aria-label="Market" className={selectCls}>
            <option value="">All markets</option>
            {markets.map((m) => (
              <option key={`${m.country}-${m.language}`} value={`${m.country}-${m.language}`}>
                {countryName(m.country)} · {languageName(m.language)}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
        {filtered ? (
          <Link href={`${base}/prompts?range=${range}`} className="text-[13px] text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        ) : null}
        <span className="tabular ml-auto text-xs text-muted-foreground">{rows.length} prompts</span>
      </FilterForm>

      {rows.length === 0 ? (
        <EmptyState icon={MessageSquareText} title={filtered ? "No prompts match these filters" : "No prompts yet"} description={filtered ? "Try clearing a filter." : "Approve prompts during setup to start tracking them."} action={filtered ? undefined : edit} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[13px]">
            <thead className="whitespace-nowrap border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Prompt</th>
                <th className="px-3 py-2.5 font-medium">Intent</th>
                <th className="px-3 py-2.5 text-right font-medium">Visibility</th>
                <th className="px-3 py-2.5 font-medium">Best competitor</th>
                {providers.map((p) => (
                  <th key={p.id} className="px-3 py-2.5 text-right font-medium">
                    {p.displayName}
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right font-medium">Trend</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-accent/40">
                  <td className="max-w-80 px-4 py-2.5">
                    <Link href={`${base}/prompts/${r.id}?range=${range}`} className="font-medium hover:underline">
                      {r.text}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      P{r.priority}
                      {r.cluster ? ` · ${r.cluster.name}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge variant="outline">{INTENT_LABELS[r.intent].label}</Badge>
                  </td>
                  <td className="tabular px-3 py-2.5 text-right font-semibold">{num1(r.visibility)}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {r.bestCompetitorName ? (
                      <>
                        {r.bestCompetitorName} <span className="tabular">{num1(r.bestCompetitor!.visibility)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  {providers.map((p) => (
                    <td key={p.id} className="tabular px-3 py-2.5 text-right">
                      {num1(r.perProvider[p.id])}
                    </td>
                  ))}
                  <td className="px-3 py-2.5 text-right">{r.answers ? <Delta value={r.trend} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2.5">
                    <PromptStatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/**
 * Pure dashboard aggregations over analyzed AI answers. Every number on the
 * dashboard comes from here, computed with the same visibility function the
 * scan snapshots use, so all pages agree with each other.
 */
import { computeVisibility, type ResolvedWeights, type VisibilityMetrics } from "@/server/scoring/visibility";
import { observe } from "@/server/scoring/observe";

export interface AnswerMention {
  isPrimaryBrand: boolean;
  competitorId: string | null;
  brandName: string;
  position: number;
  sentiment: number | null;
  snippet: string | null;
}

export interface AnswerCitation {
  ownerType: string;
  competitorId: string | null;
  domain: string;
  url: string;
  title: string | null;
  position: number;
}

export interface AnswerRow {
  responseId: string;
  promptId: string;
  providerId: string;
  createdAt: Date;
  country: string;
  language: string;
  brandsMentionedCount: number;
  mentions: AnswerMention[];
  citations: AnswerCitation[];
}

/** null = the primary brand. */
export type Subject = string | null;

export function subjectMetrics(answers: AnswerRow[], subject: Subject, weights: ResolvedWeights): VisibilityMetrics {
  return computeVisibility(answers.map((a) => observe(a, subject)), weights);
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Visibility per UTC day for each subject; days without answers are omitted (no fake zeros). */
export function dailySeries(answers: AnswerRow[], subjects: Subject[], weights: ResolvedWeights) {
  const byDay = new Map<string, AnswerRow[]>();
  for (const a of answers) byDay.set(dayKey(a.createdAt), [...(byDay.get(dayKey(a.createdAt)) ?? []), a]);
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      sampleSize: rows.length,
      scores: Object.fromEntries(subjects.map((s) => [s ?? "primary", subjectMetrics(rows, s, weights).visibilityScore])) as Record<string, number>,
    }));
}

export function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

/** Most recent answer per provider. */
export function latestPerProvider(answers: AnswerRow[]): AnswerRow[] {
  return [...groupBy(answers, (a) => a.providerId).values()].map((rows) => rows.reduce((x, y) => (y.createdAt > x.createdAt ? y : x)));
}

export type PromptStatus = "WINNING" | "VISIBLE" | "LOSING" | "NO_BRANDS" | "NOT_SCANNED";

/**
 * Status from each engine's latest answer:
 * WINNING  = you are ranked #1 in most (more than half) of the engines' latest answers
 * VISIBLE  = you are mentioned in at least one, but not #1 in most
 * LOSING   = you are absent while at least one competitor is mentioned
 * NO_BRANDS = no tracked brand mentioned at all
 */
export function promptStatus(answers: AnswerRow[]): PromptStatus {
  if (!answers.length) return "NOT_SCANNED";
  const latest = latestPerProvider(answers);
  const primary = latest.flatMap((a) => a.mentions.filter((m) => m.isPrimaryBrand));
  if (primary.filter((m) => m.position === 1).length * 2 > latest.length) return "WINNING";
  if (primary.length) return "VISIBLE";
  if (latest.some((a) => a.mentions.some((m) => !m.isPrimaryBrand))) return "LOSING";
  return "NO_BRANDS";
}

export interface PromptRow {
  promptId: string;
  answers: number;
  visibility: number | null;
  previousVisibility: number | null;
  mentionRate: number | null;
  perProvider: Record<string, number>;
  bestCompetitor: { competitorId: string; visibility: number } | null;
  status: PromptStatus;
}

export function promptRows(promptIds: string[], current: AnswerRow[], previous: AnswerRow[], competitorIds: string[], weights: ResolvedWeights): PromptRow[] {
  const cur = groupBy(current, (a) => a.promptId);
  const prev = groupBy(previous, (a) => a.promptId);
  return promptIds.map((promptId) => {
    const rows = cur.get(promptId) ?? [];
    const prevRows = prev.get(promptId) ?? [];
    const m = rows.length ? subjectMetrics(rows, null, weights) : null;
    const perProvider = Object.fromEntries([...groupBy(rows, (a) => a.providerId)].map(([p, r]) => [p, subjectMetrics(r, null, weights).visibilityScore]));
    const best = competitorIds
      .map((c) => ({ competitorId: c, visibility: subjectMetrics(rows, c, weights).visibilityScore }))
      .filter((c) => c.visibility > 0)
      .sort((a, b) => b.visibility - a.visibility)[0];
    return {
      promptId,
      answers: rows.length,
      visibility: m?.visibilityScore ?? null,
      previousVisibility: prevRows.length ? subjectMetrics(prevRows, null, weights).visibilityScore : null,
      mentionRate: m?.mentionRate ?? null,
      perProvider,
      bestCompetitor: rows.length && best ? best : null,
      status: promptStatus(rows),
    };
  });
}

export interface DomainRow {
  domain: string;
  ownerType: string;
  competitorId: string | null;
  citations: number;
  share: number;
  /** Answers citing this domain. */
  answers: number;
  promptsInfluenced: number;
  /** Answers citing this domain that mention you / any competitor. */
  withPrimary: number;
  withCompetitor: number;
  gapScore: number | null;
}

/**
 * Citation gap (0–100) for third-party domains: how strongly a source is
 * associated with competitors but not with you, weighted by how often it is cited.
 *   gap = 100 × competitorShare × (1 − primaryShare) × frequency
 *   competitorShare = answers citing it that mention a competitor / answers citing it
 *   primaryShare    = answers citing it that mention you / answers citing it
 *   frequency       = ln(1 + answers) / ln(1 + most-cited domain's answers)
 */
export function citationDomains(answers: AnswerRow[]): DomainRow[] {
  const total = answers.reduce((n, a) => n + a.citations.length, 0);
  const byDomain = new Map<string, { ownerType: string; competitorId: string | null; citations: number; answerIds: Set<string>; prompts: Set<string>; withPrimary: number; withCompetitor: number }>();
  for (const a of answers) {
    const hasPrimary = a.mentions.some((m) => m.isPrimaryBrand);
    const hasCompetitor = a.mentions.some((m) => !m.isPrimaryBrand);
    const seenInAnswer = new Set<string>();
    for (const c of a.citations) {
      const d = byDomain.get(c.domain) ?? { ownerType: c.ownerType, competitorId: c.competitorId, citations: 0, answerIds: new Set(), prompts: new Set(), withPrimary: 0, withCompetitor: 0 };
      d.citations++;
      d.prompts.add(a.promptId);
      if (!seenInAnswer.has(c.domain)) {
        seenInAnswer.add(c.domain);
        d.answerIds.add(a.responseId);
        if (hasPrimary) d.withPrimary++;
        if (hasCompetitor) d.withCompetitor++;
      }
      byDomain.set(c.domain, d);
    }
  }
  const maxAnswers = Math.max(0, ...[...byDomain.values()].map((d) => d.answerIds.size));
  const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
  return [...byDomain.entries()]
    .map(([domain, d]) => {
      const n = d.answerIds.size;
      const gap = d.ownerType === "THIRD_PARTY" && n > 0 && maxAnswers > 0 ? (d.withCompetitor / n) * (1 - d.withPrimary / n) * (Math.log(1 + n) / Math.log(1 + maxAnswers)) : null;
      return {
        domain,
        ownerType: d.ownerType,
        competitorId: d.competitorId,
        citations: d.citations,
        share: total ? r4(d.citations / total) : 0,
        answers: n,
        promptsInfluenced: d.prompts.size,
        withPrimary: d.withPrimary,
        withCompetitor: d.withCompetitor,
        gapScore: gap === null ? null : Math.round(100 * gap),
      };
    })
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));
}

/** Prompts where a competitor is mentioned in answers that don't mention you. */
export function promptsCompetitorWins(answers: AnswerRow[], competitorId: string) {
  const wins = new Map<string, { promptId: string; answers: number; bestPosition: number }>();
  for (const a of answers) {
    const comp = a.mentions.find((m) => m.competitorId === competitorId);
    if (!comp || a.mentions.some((m) => m.isPrimaryBrand)) continue;
    const w = wins.get(a.promptId) ?? { promptId: a.promptId, answers: 0, bestPosition: comp.position };
    w.answers++;
    w.bestPosition = Math.min(w.bestPosition, comp.position);
    wins.set(a.promptId, w);
  }
  return [...wins.values()].sort((a, b) => b.answers - a.answers || a.bestPosition - b.bestPosition);
}

export interface Insight {
  kind: "ABSENT" | "OUTRANKED" | "SOURCES" | "NOT_CITED" | "NEGATIVE";
  severity: "high" | "medium" | "low";
  text: string;
}

/**
 * "Why you may be losing" for one prompt — observations only, no causal claims.
 */
export function whyLosing(answers: AnswerRow[], names: { primary: string; competitor: (id: string) => string }): Insight[] {
  if (!answers.length) return [];
  const out: Insight[] = [];
  const absent = answers.filter((a) => !a.mentions.some((m) => m.isPrimaryBrand));
  if (absent.length) {
    const comps = new Map<string, number>();
    for (const a of absent) for (const m of a.mentions) if (m.competitorId) comps.set(m.competitorId, (comps.get(m.competitorId) ?? 0) + 1);
    const top = [...comps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => names.competitor(id));
    out.push({
      kind: "ABSENT",
      severity: absent.length / answers.length >= 0.5 ? "high" : "medium",
      text: `${names.primary} is missing from ${absent.length} of ${answers.length} answers${top.length ? `; ${top.join(", ")} ${top.length === 1 ? "appears" : "appear"} instead` : ""}.`,
    });
  }
  const outranked = new Map<string, number>();
  for (const a of answers) {
    const me = a.mentions.find((m) => m.isPrimaryBrand);
    if (!me) continue;
    for (const m of a.mentions) if (m.competitorId && m.position < me.position) outranked.set(m.competitorId, (outranked.get(m.competitorId) ?? 0) + 1);
  }
  const [topOut] = [...outranked.entries()].sort((a, b) => b[1] - a[1]);
  if (topOut) out.push({ kind: "OUTRANKED", severity: "medium", text: `${names.competitor(topOut[0])} is listed above ${names.primary} in ${topOut[1]} answer${topOut[1] === 1 ? "" : "s"}.` });

  const thirdParty = groupBy(absent.flatMap((a) => a.citations.filter((c) => c.ownerType === "THIRD_PARTY")), (c) => c.domain);
  const sources = [...thirdParty.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  if (sources.length) out.push({ kind: "SOURCES", severity: "medium", text: `Answers without ${names.primary} cite ${sources.map(([d, c]) => `${d} (${c.length})`).join(", ")}.` });

  if (!answers.some((a) => a.citations.some((c) => c.ownerType === "PRIMARY"))) out.push({ kind: "NOT_CITED", severity: "low", text: `None of the answers cite ${names.primary}'s website.` });

  const negative = answers.flatMap((a) => a.mentions.filter((m) => m.isPrimaryBrand && m.sentiment !== null && m.sentiment < -0.2));
  if (negative.length) out.push({ kind: "NEGATIVE", severity: "medium", text: `${names.primary} is described negatively in ${negative.length} answer${negative.length === 1 ? "" : "s"}${negative[0]!.snippet ? `: “${negative[0]!.snippet.slice(0, 140)}”` : "."}` });
  return out;
}

/** Dashboard date ranges, carried in the `range` search param. */
export const DATE_RANGES = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "12m", label: "Last 12 months", days: 365 },
] as const;

export type DateRangeKey = (typeof DATE_RANGES)[number]["key"];
export const DEFAULT_DATE_RANGE: DateRangeKey = "30d";

export function parseDateRange(value: string | string[] | undefined): DateRangeKey {
  const v = Array.isArray(value) ? value[0] : value;
  return DATE_RANGES.some((r) => r.key === v) ? (v as DateRangeKey) : DEFAULT_DATE_RANGE;
}

/**
 * Current window [from, to) plus the equally long previous window, used for
 * "+7.4 vs previous period" comparisons.
 */
export function resolveDateWindow(key: DateRangeKey, now: Date = new Date()) {
  const days = DATE_RANGES.find((r) => r.key === key)!.days;
  const to = new Date(now);
  const from = new Date(to.getTime() - days * 86_400_000);
  const previousFrom = new Date(from.getTime() - days * 86_400_000);
  return { from, to, previousFrom, previousTo: from, days };
}

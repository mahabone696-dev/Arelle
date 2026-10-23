/** Fixed categorical order: index 0 = your brand, then competitors in creation order. Never cycled. */
export const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"] as const;
export const MAX_SERIES = SERIES_COLORS.length;
export const seriesColor = (index: number) => SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)]!;

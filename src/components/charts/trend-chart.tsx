"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { seriesColor } from "./series";

export interface TrendSeries {
  key: string;
  name: string;
  /** Position in the fixed categorical order (0 = your brand). */
  colorIndex: number;
  emphasis?: boolean;
}

export interface TrendPoint {
  date: string;
  [key: string]: number | string;
}

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function TooltipBox({ active, payload, label, series }: { active?: boolean; payload?: Array<{ dataKey: string; value: number }>; label?: string; series: TrendSeries[] }) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((p) => [p.dataKey, p.value]));
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium">{label ? fmtDate(label) : ""}</div>
      <ul className="grid gap-0.5">
        {[...series]
          .sort((a, b) => (byKey.get(b.key) ?? -1) - (byKey.get(a.key) ?? -1))
          .map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: seriesColor(s.colorIndex) }} aria-hidden />
              <span className={s.emphasis ? "font-medium text-foreground" : "text-muted-foreground"}>{s.name}</span>
              <span className="tabular ml-auto pl-4 text-foreground">{byKey.get(s.key)?.toFixed(1) ?? "—"}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Visibility (0–100) over time. One y-axis; your brand is drawn on top and slightly heavier. */
export function TrendChart({ data, series, height = 240 }: { data: TrendPoint[]; series: TrendSeries[]; height?: number }) {
  const ordered = [...series].sort((a, b) => Number(!!a.emphasis) - Number(!!b.emphasis));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<TooltipBox series={series} />} cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }} />
          {ordered.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={seriesColor(s.colorIndex)}
              strokeWidth={s.emphasis ? 2.5 : 2}
              strokeOpacity={s.emphasis ? 1 : 0.85}
              dot={data.length <= 12 ? { r: s.emphasis ? 3.5 : 2.5, strokeWidth: 2, stroke: "var(--card)", fill: seriesColor(s.colorIndex) } : false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--card)" }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ChartLegend({ series }: { series: TrendSeries[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: seriesColor(s.colorIndex) }} aria-hidden />
          <span className={s.emphasis ? "font-medium text-foreground" : undefined}>{s.name}</span>
        </li>
      ))}
    </ul>
  );
}

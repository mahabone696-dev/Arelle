"use client";

import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { seriesColor } from "./series";

export interface BarItem {
  name: string;
  value: number;
  colorIndex: number;
  emphasis?: boolean;
}

/** Horizontal bars, one per brand, value labelled at the bar end (identity is never color-only). */
export function BarCompare({ items, max = 100, unit = "" }: { items: BarItem[]; max?: number; unit?: string }) {
  const height = Math.max(120, items.length * 36 + 16);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={items} layout="vertical" margin={{ top: 4, right: 40, bottom: 4, left: 4 }} barCategoryGap={8}>
          <XAxis type="number" domain={[0, max]} hide />
          <YAxis type="category" dataKey="name" width={120} tick={{ fill: "var(--foreground)", fontSize: 12 }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: "var(--accent)" }}
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <div className="rounded-md border bg-popover px-3 py-1.5 text-xs shadow-md">
                  {(payload[0].payload as BarItem).name}: <span className="tabular font-medium">{Number(payload[0].value).toFixed(1)}{unit}</span>
                </div>
              ) : null
            }
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {items.map((it) => (
              <Cell key={it.name} fill={seriesColor(it.colorIndex)} fillOpacity={it.emphasis ? 1 : 0.8} />
            ))}
            <LabelList dataKey="value" position="right" formatter={(v) => `${Number(v).toFixed(1)}${unit}`} style={{ fill: "var(--foreground)", fontSize: 12 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

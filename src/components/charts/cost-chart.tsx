"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usd } from "@/lib/format";

export interface CostPoint {
  day: string;
  cost: number;
  answers: number;
}

const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function TooltipBox({ active, payload, label }: { active?: boolean; payload?: Array<{ payload: CostPoint }>; label?: string }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium">{label ? fmtDay(label) : ""}</div>
      <div className="tabular mt-0.5">{usd(p.cost)}</div>
      <div className="text-muted-foreground">{p.answers} answers</div>
    </div>
  );
}

/** Estimated AI engine cost per day (single series, one axis). */
export function CostChart({ data, height = 180 }: { data: CostPoint[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="day" tickFormatter={fmtDay} tick={{ fontSize: 11, fill: "var(--chart-axis)" }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickFormatter={usd} tick={{ fontSize: 11, fill: "var(--chart-axis)" }} tickLine={false} axisLine={false} width={52} />
          <Tooltip content={<TooltipBox />} cursor={{ fill: "var(--chart-grid)", opacity: 0.5 }} />
          <Bar dataKey="cost" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

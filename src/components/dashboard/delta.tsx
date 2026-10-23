import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Change vs the previous period. `better` says which direction is good
 * (average position improves when it goes DOWN). Color is paired with an arrow and sign.
 */
export function Delta({ value, unit = "", better = "up", suffix }: { value: number | null | undefined; unit?: string; better?: "up" | "down"; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted-foreground">No previous data</span>;
  if (value === 0) return <span className="tabular text-xs text-muted-foreground">No change{suffix ? ` ${suffix}` : ""}</span>;
  const good = better === "up" ? value > 0 : value < 0;
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={cn("tabular inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-success" : "text-destructive")}>
      <Icon className="size-3" aria-hidden />
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}
      {unit}
      {suffix ? <span className="ml-1 font-normal text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);
export const num1 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(1));

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** KPI tile. `value` null renders an explicit "no data" dash rather than a fake number. */
export function MetricCard({ label, value, unit, hint, footer, className }: { label: string; value: string | null; unit?: string; hint?: string; footer?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("px-5 py-4", className)}>
      <div className="text-[13px] text-muted-foreground" title={hint}>
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="tabular text-2xl font-semibold tracking-tight">{value ?? "—"}</span>
        {value !== null && unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
      </div>
      {footer ? <div className="mt-1">{footer}</div> : hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </Card>
  );
}

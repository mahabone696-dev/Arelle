import { Badge } from "@/components/ui/badge";
import type { PromptStatus } from "@/server/dashboard/aggregate";

const STATUS: Record<PromptStatus, { label: string; variant: "success" | "default" | "destructive" | "outline" | "warning"; hint: string }> = {
  WINNING: { label: "Winning", variant: "success", hint: "Ranked #1 in most engines' latest answers" },
  VISIBLE: { label: "Visible", variant: "default", hint: "Mentioned, but not first" },
  LOSING: { label: "Losing", variant: "destructive", hint: "Absent while competitors are mentioned" },
  NO_BRANDS: { label: "No brands", variant: "outline", hint: "No tracked brand is mentioned" },
  NOT_SCANNED: { label: "Not scanned", variant: "outline", hint: "No answers in this period" },
};

export const PROMPT_STATUSES = Object.keys(STATUS) as PromptStatus[];
export const statusLabel = (s: PromptStatus) => STATUS[s].label;

export function PromptStatusBadge({ status }: { status: PromptStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} title={s.hint}>
      {s.label}
    </Badge>
  );
}

import { Badge } from "@/components/ui/badge";

const VARIANT = {
  QUEUED: "outline",
  RUNNING: "outline",
  COMPLETED: "success",
  PARTIAL: "warning",
  FAILED: "destructive",
  CANCELLED: "default",
} as const;

export function ScanStatusBadge({ status }: { status: keyof typeof VARIANT }) {
  return <Badge variant={VARIANT[status]}>{status === "PARTIAL" ? "Partial" : status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}

export const formatUsd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

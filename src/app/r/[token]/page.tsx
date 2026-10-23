import type { Metadata } from "next";
import { headers } from "next/headers";
import { ReportView } from "@/components/reports/report-view";
import { resolveShare } from "@/server/reports/service";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/request";

// Shared reports are private links: never indexed, and the token never leaks via Referer.
export const metadata: Metadata = { title: "AI visibility report", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

const MESSAGES = {
  NOT_FOUND: "This report link isn't valid.",
  EXPIRED: "This report link has expired. Ask the sender for a new one.",
  REVOKED: "This report link has been turned off by its owner.",
  PLAN: "This report isn't available right now.",
  RATE_LIMITED: "Too many requests. Please wait a minute and try again.",
} as const;

function Notice({ text }: { text: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{text}</p>
    </main>
  );
}

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = clientIpFromHeaders(await headers());
  if (!(await rateLimit(`report:view:${ip}`, 60, 60_000)).allowed) return <Notice text={MESSAGES.RATE_LIMITED} />;
  const res = await resolveShare(token);
  if (!res.ok) return <Notice text={MESSAGES[res.reason]} />;
  return (
    <main className="min-h-dvh bg-background px-4 py-8 print:p-0">
      <ReportView report={res.report} title={res.title} branding={res.branding} />
    </main>
  );
}

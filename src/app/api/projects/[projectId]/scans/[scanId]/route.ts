import { NextResponse } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { getScanProgress } from "@/server/scans/service";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** Scan progress for polling ("Scanning 47 / 90 responses"). */
export async function GET(_req: Request, ctx: { params: Promise<{ projectId: string; scanId: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { projectId, scanId } = await ctx.params;
  try {
    const progress = await getScanProgress(user.id, projectId, scanId);
    return NextResponse.json(progress, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isAppError(error)) return NextResponse.json({ error: error.code, message: error.message }, { status: error.httpStatus });
    logger.error("api.scan_progress_failed", { error, scanId });
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}

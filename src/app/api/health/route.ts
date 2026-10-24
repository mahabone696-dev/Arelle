import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok" });
  } catch (error) {
    logger.error("health.db_failed", { error });
    return NextResponse.json({ status: "degraded", db: "error" }, { status: 503 });
  }
}

"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestAudit } from "@/server/audit/service";
import { formValues, isAppError, type ActionResult } from "@/lib/errors";
import { clientIpFromHeaders } from "@/lib/request";
import { logger } from "@/lib/logger";

export async function startAuditAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const values = formValues(form, ["formToken", "website"]);
  let auditId: string;
  try {
    ({ auditId } = await requestAudit(Object.fromEntries(form), clientIpFromHeaders(await headers())));
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, values };
    if (error && typeof error === "object" && "issues" in error) return { ok: false, error: "Enter a website like example.com.", values };
    logger.error("audit.request_failed", { error });
    return { ok: false, error: "Something went wrong. Please try again.", values };
  }
  redirect(`/audit/${auditId}`);
}

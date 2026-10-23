"use server";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { requireOrgAccess } from "@/server/auth/authorization";
import { createCheckoutSession, createPortalSession } from "@/server/billing/stripe";
import { PAID_TIERS, type PaidTier } from "@/server/billing/plans";
import { AppError, type ActionResult } from "@/lib/errors";
import { toActionError } from "@/lib/action-result";

async function orgFor(orgSlug: string) {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
  const access = await requireOrgAccess(user.id, { slug: orgSlug }, "billing:manage");
  return { user, organizationId: access.organizationId };
}

export async function checkoutAction(orgSlug: string, tier: PaidTier): Promise<ActionResult> {
  let url: string;
  try {
    if (!PAID_TIERS.includes(tier)) throw new AppError("VALIDATION", "Unknown plan.");
    const { user, organizationId } = await orgFor(orgSlug);
    url = (await createCheckoutSession(user.id, organizationId, tier)).url;
  } catch (error) {
    return toActionError(error);
  }
  redirect(url);
}

export async function portalAction(orgSlug: string): Promise<ActionResult> {
  let url: string;
  try {
    const { user, organizationId } = await orgFor(orgSlug);
    url = (await createPortalSession(user.id, organizationId)).url;
  } catch (error) {
    return toActionError(error);
  }
  redirect(url);
}

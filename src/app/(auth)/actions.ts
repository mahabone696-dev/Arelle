"use server";

import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { signIn } from "@/server/auth";
import { registerUser, signUpSchema } from "@/server/auth/sign-up";
import { formValues, isAppError, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/request";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { logger } from "@/lib/logger";

const WINDOW_MS = 15 * 60 * 1000;

async function limited(bucket: string, limit: number): Promise<boolean> {
  const ip = clientIpFromHeaders(await headers());
  const result = await rateLimit(`${bucket}:${ip}`, limit, WINDOW_MS);
  return !result.allowed;
}

function safeRedirect(target: FormDataEntryValue | null): string {
  return safeRedirectPath(target, process.env.AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
}

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: safeRedirect(formData.get("callbackUrl")),
    });
    return { ok: true, data: undefined };
  } catch (error) {
    // Rate-limited attempts also surface here; the message stays generic on purpose.
    if (error instanceof AuthError) return { ok: false, error: "Incorrect email or password, or too many attempts.", values: formValues(formData, ["password"]) };
    throw error; // includes the redirect thrown on success
  }
}

export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const values = formValues(formData, ["password"]);
  if (await limited("sign-up", 5)) return { ok: false, error: "Too many sign-up attempts. Try again later.", values };
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.error.flatten().fieldErrors, values };
  }
  try {
    await registerUser(parsed.data);
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, values };
    logger.error("auth.sign_up_failed", { error });
    return { ok: false, error: "Something went wrong. Please try again.", values };
  }
  try {
    await signIn("credentials", { email: parsed.data.email, password: parsed.data.password, redirectTo: "/" });
    return { ok: true, data: undefined };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, error: "Account created — please sign in." };
    throw error;
  }
}

export async function oauthSignInAction(formData: FormData): Promise<void> {
  const provider = formData.get("provider");
  if (provider !== "google" && provider !== "github") return;
  await signIn(provider, { redirectTo: safeRedirect(formData.get("callbackUrl")) });
}

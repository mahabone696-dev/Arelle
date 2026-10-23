import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getSessionUser } from "@/server/auth/session";
import { enabledOAuthProviders } from "@/server/auth";
import { OAuthButtons } from "../oauth-buttons";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; audit?: string }> }) {
  const sp = await searchParams;
  // Coming from a free audit: continue into onboarding with the audited website.
  const callbackUrl = sp.audit && /^[a-z0-9]{20,32}$/.test(sp.audit) ? `/audit/${sp.audit}/continue` : sp.callbackUrl;
  if (await getSessionUser()) redirect(callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create your account</CardTitle>
        <CardDescription>{sp.audit ? "Free account — unlock your full audit and track it over time." : "See how your brand shows up in AI answers."}</CardDescription>
      </CardHeader>
      <CardContent>
        <OAuthButtons providers={enabledOAuthProviders()} callbackUrl={callbackUrl} />
        <SignUpForm callbackUrl={callbackUrl} />
        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          Already have an account?{" "}
          <Link href={callbackUrl ? `/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/sign-in"} className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

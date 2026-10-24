import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getSessionUser } from "@/server/auth/session";
import { enabledOAuthProviders } from "@/server/auth";
import { OAuthButtons } from "../oauth-buttons";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  if (await getSessionUser()) redirect("/");
  const { callbackUrl } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sign in</CardTitle>
        <CardDescription>Welcome back. Sign in to your workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <OAuthButtons providers={enabledOAuthProviders()} callbackUrl={callbackUrl} />
        <SignInForm callbackUrl={callbackUrl} />
        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          No account?{" "}
          <Link href="/sign-up" className="font-medium text-foreground hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

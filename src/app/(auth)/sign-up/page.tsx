import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getSessionUser } from "@/server/auth/session";
import { enabledOAuthProviders } from "@/server/auth";
import { OAuthButtons } from "../oauth-buttons";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage() {
  if (await getSessionUser()) redirect("/");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create your account</CardTitle>
        <CardDescription>See how your brand shows up in AI answers.</CardDescription>
      </CardHeader>
      <CardContent>
        <OAuthButtons providers={enabledOAuthProviders()} />
        <SignUpForm />
        <p className="mt-5 text-center text-[13px] text-muted-foreground">
          Already have an account?{" "}
          <Link href="/sign-in" className="font-medium text-foreground hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

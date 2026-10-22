import Link from "next/link";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/layout/user-menu";

export function OnboardingShell({
  user,
  stepper,
  children,
  exitHref,
}: {
  user: { name: string | null; email: string | null; image: string | null };
  stepper: React.ReactNode;
  children: React.ReactNode;
  exitHref: string;
}) {
  return (
    <div className="min-h-dvh bg-sidebar">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <Link href={exitHref} aria-label="Exit setup">
            <Logo />
          </Link>
          <div className="mx-auto">{stepper}</div>
          <UserMenu {...user} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-8 md:py-12">{children}</main>
    </div>
  );
}

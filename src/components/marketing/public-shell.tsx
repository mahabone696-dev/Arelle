import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

/** Header/footer for public (signed-out) pages: landing, free audit. */
export function PublicShell({ children, signedIn = false }: { children: React.ReactNode; signedIn?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-4">
          <Link href="/" aria-label="Arelle home">
            <Logo />
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-[13px]">
            <Link href="/audit" className="hidden rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground sm:inline">
              Free audit
            </Link>
            {signedIn ? (
              <Button asChild size="sm">
                <Link href="/">Open app</Link>
              </Button>
            ) : (
              <>
                <Link href="/sign-in" className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground">
                  Sign in
                </Link>
                <Button asChild size="sm">
                  <Link href="/sign-up">Create free account</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-5xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-xs text-muted-foreground">
          <span>© {new Date().getUTCFullYear()} Arelle</span>
          <span>Results reflect sampled AI answers at the time of the check. AI engines change; no ranking outcome is guaranteed.</span>
        </div>
      </footer>
    </div>
  );
}

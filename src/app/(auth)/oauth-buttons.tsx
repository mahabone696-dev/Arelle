import { Button } from "@/components/ui/button";
import { oauthSignInAction } from "./actions";

const LABELS = { google: "Continue with Google", github: "Continue with GitHub" } as const;

export function OAuthButtons({ providers, callbackUrl }: { providers: Array<keyof typeof LABELS>; callbackUrl?: string }) {
  if (providers.length === 0) return null;
  return (
    <>
      <div className="grid gap-2">
        {providers.map((p) => (
          <form key={p} action={oauthSignInAction}>
            <input type="hidden" name="provider" value={p} />
            <input type="hidden" name="callbackUrl" value={callbackUrl ?? "/"} />
            <Button type="submit" variant="outline" className="w-full">
              {LABELS[p]}
            </Button>
          </form>
        ))}
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

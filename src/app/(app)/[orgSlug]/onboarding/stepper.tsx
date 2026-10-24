import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "website", label: "Website" },
  { key: "brand", label: "Brand" },
  { key: "competitors", label: "Competitors" },
  { key: "prompts", label: "Prompts" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

/** Steps up to `reached` are links (users can go back and edit); later steps are inert. */
export function Stepper({ current, reached, basePath }: { current: StepKey; reached: StepKey; basePath?: string }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  const reachedIdx = STEPS.findIndex((s) => s.key === reached);
  return (
    <ol className="flex items-center gap-2 text-[13px]" aria-label="Setup progress">
      {STEPS.map((step, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const linkable = basePath && i > 0 && i <= reachedIdx && !active;
        const content = (
          <span className={cn("flex items-center gap-2", active ? "font-medium text-foreground" : "text-muted-foreground")}>
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[11px] tabular",
                done && "border-primary bg-primary text-primary-foreground",
                active && "border-primary text-foreground",
              )}
            >
              {done ? <Check className="size-3" /> : i + 1}
            </span>
            <span className="hidden sm:inline">{step.label}</span>
          </span>
        );
        return (
          <li key={step.key} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {linkable ? (
              <Link href={`${basePath}/${step.key}`} className="hover:underline">
                {content}
              </Link>
            ) : (
              content
            )}
            {i < STEPS.length - 1 ? <span className="h-px w-6 bg-border sm:w-10" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function stepFromOnboarding(step: string): StepKey {
  if (step === "COMPETITORS") return "competitors";
  if (step === "PROMPTS" || step === "COMPLETED") return "prompts";
  return "brand";
}

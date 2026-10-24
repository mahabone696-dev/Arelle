import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight", className)}>
      <svg viewBox="0 0 20 20" className="size-5" aria-hidden>
        <rect width="20" height="20" rx="5" className="fill-primary" />
        <path d="M5 14l3.5-8h3L15 14h-2.4l-.7-1.8H8.1L7.4 14H5zm3.8-3.6h2.4L10 7.3l-1.2 3.1z" className="fill-primary-foreground" />
      </svg>
      <span>Arelle</span>
    </span>
  );
}

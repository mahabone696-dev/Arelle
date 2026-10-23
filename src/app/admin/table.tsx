import { cn } from "@/lib/utils";

/** Compact admin table: horizontal scroll on narrow screens, never the page. */
export function AdminTable({ head, children, empty }: { head: Array<string | { label: string; right?: boolean }>; children: React.ReactNode; empty?: string }) {
  const hasRows = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-[13px]">
        <thead className="whitespace-nowrap border-b text-left text-xs text-muted-foreground">
          <tr>
            {head.map((h) => {
              const { label, right } = typeof h === "string" ? { label: h, right: false } : h;
              return (
                <th key={label} className={cn("px-3 py-2 font-medium", right && "text-right")}>
                  {label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
      {!hasRows ? <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{empty ?? "Nothing here."}</p> : null}
    </div>
  );
}

export function SearchBox({ placeholder, q }: { placeholder: string; q?: string }) {
  return (
    <form className="mb-4" role="search">
      <input name="q" defaultValue={q} placeholder={placeholder} aria-label={placeholder} className="h-9 w-full max-w-sm rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
    </form>
  );
}

export const when = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");
export const Td = ({ children, right, className }: { children: React.ReactNode; right?: boolean; className?: string }) => <td className={cn("px-3 py-2 align-top", right && "tabular text-right", className)}>{children}</td>;

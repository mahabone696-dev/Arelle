"use client";

import { useRef } from "react";

/** GET form that re-submits when a select changes; works without JS via the Apply button. */
export function FilterForm({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form ref={ref} method="get" className={className} onChange={(e) => (e.target as HTMLElement).tagName === "SELECT" && ref.current?.requestSubmit()}>
      {children}
    </form>
  );
}

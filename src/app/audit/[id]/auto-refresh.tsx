"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-render the server page every few seconds while the audit runs (stops after ~5 minutes). */
export function AutoRefresh({ everyMs = 3000, maxTicks = 100 }: { everyMs?: number; maxTicks?: number }) {
  const router = useRouter();
  useEffect(() => {
    let ticks = 0;
    const t = setInterval(() => {
      if (++ticks > maxTicks) return clearInterval(t);
      router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, maxTicks]);
  return null;
}

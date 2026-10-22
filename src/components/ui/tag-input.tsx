"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Chip list editor. Submits its value as a JSON array in a hidden input named `name`. */
export function TagInput({
  id,
  name,
  defaultValue = [],
  placeholder,
  max = 15,
}: {
  id: string;
  name: string;
  defaultValue?: string[];
  placeholder?: string;
  max?: number;
}) {
  const [tags, setTags] = React.useState<string[]>(defaultValue);
  const [draft, setDraft] = React.useState("");

  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setTags((t) => [...new Set([...t, ...parts])].slice(0, max));
    setDraft("");
  };

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
      <input type="hidden" name={name} value={JSON.stringify(tags)} />
      {tags.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[13px]">
          {tag}
          <button type="button" onClick={() => setTags((t) => t.filter((x) => x !== tag))} className="text-muted-foreground hover:text-foreground" aria-label={`Remove ${tag}`}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        disabled={tags.length >= max}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && tags.length) {
            setTags((t) => t.slice(0, -1));
          }
        }}
        onBlur={() => add(draft)}
        placeholder={tags.length ? "" : placeholder}
        className={cn("min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground")}
      />
    </div>
  );
}

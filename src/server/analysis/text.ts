/** Text helpers shared by analysis modules. Deterministic, Unicode-aware. */

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * Splits text into sentence-like segments: line breaks (list items, headings)
 * and sentence punctuation followed by whitespace + capital/digit.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /[^\n]+/g;
  for (let line = re.exec(text); line; line = re.exec(text)) {
    const base = line.index;
    // Split after . ! ? — but not after a list marker ("3. Foo") or a common abbreviation ("vs. Foo").
    const parts = line[0].split(/(?<=[.!?])(?<!^\s*\d+[.)])(?<!\b(?:e\.g|i\.e|vs|etc|inc|ltd|co|corp|mr|ms|dr|st|no|approx)\.)\s+(?=[\p{Lu}\p{N}"“(])/iu);
    let offset = 0;
    for (const part of parts) {
      const idx = line[0].indexOf(part, offset);
      const trimmed = part.trim();
      if (trimmed) out.push({ text: trimmed, start: base + idx, end: base + idx + part.length });
      offset = idx + part.length;
    }
  }
  return out;
}

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tokenizes into lowercase word tokens (letters, digits, apostrophes). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
}

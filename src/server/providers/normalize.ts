/**
 * Deterministic answer normalization: markdown removed, Unicode NFC,
 * whitespace collapsed. The raw text is always stored alongside; analysis
 * (Phase 4) runs on the normalized text.
 */
export function normalizeAnswerText(raw: string): string {
  return (
    raw
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      // Code fences: keep content, drop fence lines.
      .replace(/^```[^\n]*\n?/gm, "")
      // Images, then links → link text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
      // Headings, blockquotes.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
      // Bold/italic/strike/inline code markers (not intra-word underscores).
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
      .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,;:!?]|$)/gm, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      // Unordered list bullets → "- ".
      .replace(/^[ \t]*[*+•][ \t]+/gm, "- ")
      // Table separator rows and pipes.
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, "")
      .replace(/^[ \t]*\|[ \t]*/gm, "")
      .replace(/[ \t]*\|[ \t]*$/gm, "")
      .replace(/[ \t]*\|[ \t]*/g, " | ")
      // Whitespace.
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

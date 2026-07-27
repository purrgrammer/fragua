// Shared presentation helpers for the built-in tool result cards
// (WebFetchResult, SkillToolResult). Kept in one place so the class
// strings and the content-block extractor can't drift between cards.

export const SECTION_LABEL =
  "font-medium uppercase text-[length:var(--sw-text-xs)] text-[var(--sw-muted)] tracking-[0.06em]";

export const PANEL =
  "rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] bg-[var(--sw-surface)] " +
  "px-[var(--sw-space-3)] py-[var(--sw-space-2)] text-[length:var(--sw-text-xs)]";

/** First `text` block out of a tool result's `content` array, or "". */
export function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return "";
}

// Character-first-then-line truncation, per Attractor Coding Agent Loop spec.
// Char limit runs first (prevents a single huge line slipping past the line cap).

import type { TruncationPolicy } from "./types.ts";

const WARNING_TEMPLATE = (removed: number): string =>
  `\n[WARNING: Tool output was truncated. ${removed} characters removed. The full output is available in the event stream.]\n`;

export function truncate(output: string, policy: TruncationPolicy): string {
  let result = truncateChars(output, policy.max_chars, policy.mode);
  if (policy.max_lines !== undefined) {
    result = truncateLines(result, policy.max_lines);
  }
  return result;
}

function truncateChars(output: string, maxChars: number, mode: "head_tail" | "tail"): string {
  if (output.length <= maxChars) return output;
  const removed = output.length - maxChars;
  if (mode === "head_tail") {
    const half = Math.floor(maxChars / 2);
    return `${output.slice(0, half)}${WARNING_TEMPLATE(removed)}${output.slice(output.length - (maxChars - half))}`;
  }
  return `${WARNING_TEMPLATE(removed)}${output.slice(output.length - maxChars)}`;
}

function truncateLines(output: string, maxLines: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) return output;
  const removed = lines.length - maxLines;
  const half = Math.floor(maxLines / 2);
  return [
    ...lines.slice(0, half),
    `[WARNING: ${removed} lines omitted]`,
    ...lines.slice(lines.length - (maxLines - half)),
  ].join("\n");
}

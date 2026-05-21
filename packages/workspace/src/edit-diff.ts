// Edit-diff utilities — exact-text replacement with fuzzy fallback,
// LF/CRLF/BOM round-tripping, and unified-diff output with per-line
// numbering. Ported from pi-coding-agent's edit-diff.ts so fragua and
// the upstream coding agent stay in sync on edit semantics.
//
// The fuzzy normalization handles common provider quirks:
//   - smart quotes / curly apostrophes (LLMs often emit these even
//     when the source uses straight ASCII)
//   - Unicode dashes and minus sign collapsing to ASCII hyphen
//   - non-ASCII spaces (NBSP, narrow NBSP, ideographic) collapsing to
//     regular space
//   - trailing whitespace per line stripped
//   - NFKC normalization for compatibility decomposition
//
// generateDiffString uses the `diff` library so hunk math stays
// correct as line indices advance independently in old/new content.

import * as Diff from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Strip a leading UTF-8 BOM. The model never emits an invisible BOM
 * in `oldText`; matching against the BOM-stripped content prevents a
 * spurious mismatch on files that start with one. */
export function stripBom(content: string): { bom: string; text: string } {
  return content.charCodeAt(0) === 0xfeff ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

/** Normalize text for fuzzy matching. Applies progressive
 * transformations — strip trailing whitespace per line, NFKC, smart
 * quotes → ASCII, dashes → "-", non-ASCII spaces → " ". */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // Smart single quotes (U+2018, U+2019, U+201A, U+201B) → '
      .replace(/[‘’‚‛]/g, "'")
      // Smart double quotes (U+201C, U+201D, U+201E, U+201F) → "
      .replace(/[“”„‟]/g, '"')
      // Various dashes/hyphens → -
      // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
      // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
      .replace(/[‐‑‒–—―−]/g, "-")
      // Special spaces → regular space
      // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
      // U+205F medium math space, U+3000 ideographic space
      .replace(/[  -   　]/g, " ")
  );
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  /** Content to use for replacement: original on exact match, normalized on fuzzy. */
  contentForReplacement: string;
}

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

/** Find oldText in content. Tries exact match first; falls back to
 * fuzzy match in normalized space. When fuzzy is used, the returned
 * `contentForReplacement` is the normalized content — replacement
 * outputs will reflect the normalization (acceptable since we're
 * already accepting minor formatting differences). */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    const secondIdx = content.indexOf(oldText, exactIndex + 1);
    if (secondIdx !== -1) {
      return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
    }
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  const secondFuzzy = fuzzyContent.indexOf(fuzzyOldText, fuzzyIndex + 1);
  if (secondFuzzy !== -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

function countOccurrences(content: string, oldText: string): number {
  if (oldText.length === 0) return 0;
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path} (oldText not found). The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path} (oldText not found). Each oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Provide more surrounding context to disambiguate.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Provide more surrounding context to disambiguate.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. Check for invisible characters or text that does not exist as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits match against the same base content. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized space so the
 * remaining edits see a consistent base. Replacements apply in
 * descending index order so earlier offsets stay valid.
 *
 * Throws on: empty oldText, not-found, duplicate match, overlapping
 * edits, or no net change. Error messages reference edits[i] when the
 * call has more than one edit so the model can self-correct. */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // Probe whether any edit needs fuzzy matching against the original
  // content. If so, we re-resolve every edit against the normalized
  // base so offsets stay consistent.
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const matchResult = fuzzyFindText(baseContent, edit.oldText);
    if (!matchResult.found) {
      // Distinguish "duplicate" from "not found" so the model knows
      // whether to add context or pick a different region.
      const occurrences = countOccurrences(baseContent, edit.oldText);
      if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
      throw getNotFoundError(path, i, normalizedEdits.length);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  // Reject overlap by sorting on match index and checking adjacency.
  const byPosition = [...matchedEdits].sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < byPosition.length; i++) {
    const previous = byPosition[i - 1]!;
    const current = byPosition[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `Overlapping edits in ${path}: edits[${previous.editIndex}] and edits[${current.editIndex}] match overlapping regions. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  // Apply in descending order so earlier match indices stay valid.
  const descending = [...byPosition].sort((a, b) => b.matchIndex - a.matchIndex);
  let newContent = baseContent;
  for (const edit of descending) {
    newContent =
      newContent.slice(0, edit.matchIndex) + edit.newText + newContent.slice(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent };
}

/** Generate a unified diff string with line numbers and limited
 * context. Each line is prefixed with `+`, `-`, or ` ` and the line
 * number in the corresponding file. Context windows compress runs of
 * unchanged lines longer than `contextLines * 2` to a `...` marker. */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    // Context block. Surface only N lines on each side of an adjacent
    // change; collapse the middle to a single `...` placeholder.
    const nextPartIsChange = i < parts.length - 1 && (parts[i + 1]!.added || parts[i + 1]!.removed);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        for (const line of raw) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        const leadingLines = raw.slice(0, contextLines);
        const trailingLines = raw.slice(raw.length - contextLines);
        const skippedLines = raw.length - leadingLines.length - trailingLines.length;

        for (const line of leadingLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
        for (const line of trailingLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      }
    } else if (hasLeadingChange) {
      const shownLines = raw.slice(0, contextLines);
      const skippedLines = raw.length - shownLines.length;
      for (const line of shownLines) {
        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
        output.push(` ${lineNum} ${line}`);
        oldLineNum++;
        newLineNum++;
      }
      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }
    } else if (hasTrailingChange) {
      const skippedLines = Math.max(0, raw.length - contextLines);
      if (skippedLines > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skippedLines;
        newLineNum += skippedLines;
      }
      for (const line of raw.slice(skippedLines)) {
        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
        output.push(` ${lineNum} ${line}`);
        oldLineNum++;
        newLineNum++;
      }
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface EditDiffError {
  error: string;
}

/** Compute the diff for one or more edits without applying them.
 * Useful for previews / dry-run / pre-approval flows. Reads the file
 * through the supplied env so it stays consistent with the worktree
 * the live edit would target. */
export async function computeEditsDiff(
  path: string,
  edits: Edit[],
  env: { readFile(p: string): Promise<string>; exists(p: string): Promise<boolean> },
): Promise<EditDiffResult | EditDiffError> {
  try {
    if (!(await env.exists(path))) return { error: `File not found: ${path}` };
    const rawContent = await env.readFile(path);
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
    return generateDiffString(baseContent, newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

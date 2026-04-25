export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  if (ending === "\n") return text;
  return text.replace(/\n/g, "\r\n");
}

export function stripBom(content: string): { bom: string; text: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content[0]!, text: content.slice(1) };
  }
  return { bom: "", text: content };
}

const SMART_QUOTES: Array<[RegExp, string]> = [
  [/\u2018/g, "'"],
  [/\u2019/g, "'"],
  [/\u201C/g, '"'],
  [/\u201D/g, '"'],
  [/[\u2013\u2014\u2015]/g, "-"],
  [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " "],
];

export function normalizeForFuzzyMatch(text: string): string {
  let result = text.replace(/[ \t]+$/gm, "");
  for (const [pattern, replacement] of SMART_QUOTES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIdx = content.indexOf(oldText);
  if (exactIdx !== -1) {
    const secondIdx = content.indexOf(oldText, exactIdx + 1);
    if (secondIdx === -1) {
      return {
        found: true,
        index: exactIdx,
        matchLength: oldText.length,
        usedFuzzyMatch: false,
        contentForReplacement: content,
      };
    }
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }

  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOld = normalizeForFuzzyMatch(oldText);

  const fuzzyIdx = normalizedContent.indexOf(normalizedOld);
  if (fuzzyIdx !== -1) {
    const secondFuzzy = normalizedContent.indexOf(normalizedOld, fuzzyIdx + 1);
    if (secondFuzzy === -1) {
      return {
        found: true,
        index: fuzzyIdx,
        matchLength: normalizedOld.length,
        usedFuzzyMatch: true,
        contentForReplacement: normalizedContent,
      };
    }
  }

  return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
}

export interface Edit {
  oldText: string;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  let anyFuzzy = false;
  const matches: Array<{ index: number; matchLength: number; newText: string }> = [];

  for (const edit of edits) {
    const normalizedOld = normalizeToLF(edit.oldText);
    const match = fuzzyFindText(normalizedContent, normalizedOld);

    if (!match.found) {
      throw new Error(`old_string not found in ${path}. Double-check whitespace + surrounding context.`);
    }
    if (match.usedFuzzyMatch) anyFuzzy = true;

    matches.push({
      index: match.index,
      matchLength: match.matchLength,
      newText: normalizeToLF(edit.newText),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      const a = matches[i]!;
      const b = matches[j]!;
      const aEnd = a.index + a.matchLength;
      const bEnd = b.index + b.matchLength;
      if (a.index < bEnd && b.index < aEnd) {
        throw new Error(
          `Overlapping edits in ${path}: edit ${i + 1} and edit ${j + 1} match overlapping regions. Merge them into one edit.`,
        );
      }
    }
  }

  const baseContent = anyFuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
  const sorted = [...matches].sort((a, b) => b.index - a.index);
  let result = baseContent;
  for (const m of sorted) {
    result = result.slice(0, m.index) + m.newText + result.slice(m.index + m.matchLength);
  }

  return { baseContent, newContent: result };
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 3,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const hunks: string[] = [];
  let firstChangedLine: number | undefined;

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++;
      j++;
      continue;
    }

    if (firstChangedLine === undefined) firstChangedLine = j + 1;

    const contextStart = Math.max(0, i - contextLines);
    let iEnd = i;
    let jEnd = j;

    while (iEnd < oldLines.length || jEnd < newLines.length) {
      if (iEnd < oldLines.length && jEnd < newLines.length && oldLines[iEnd] === newLines[jEnd]) {
        let matchLen = 0;
        while (
          iEnd + matchLen < oldLines.length &&
          jEnd + matchLen < newLines.length &&
          oldLines[iEnd + matchLen] === newLines[jEnd + matchLen]
        ) {
          matchLen++;
        }
        if (matchLen > contextLines * 2) break;
        iEnd += matchLen;
        jEnd += matchLen;
      } else {
        if (iEnd < oldLines.length && (jEnd >= newLines.length || oldLines[iEnd] !== newLines[jEnd])) iEnd++;
        if (jEnd < newLines.length && (iEnd >= oldLines.length || oldLines[iEnd] !== newLines[jEnd])) jEnd++;
      }
    }

    const contextEnd = Math.min(oldLines.length, iEnd + contextLines);
    const newContextEnd = Math.min(newLines.length, jEnd + contextLines);

    const hunkOldStart = contextStart + 1;
    const hunkOldLen = contextEnd - contextStart;
    const hunkNewStart = contextStart + 1 + (j - i);

    hunks.push(
      `@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${Math.max(0, newContextEnd - (contextStart + (j - i)))} @@`,
    );

    for (let c = contextStart; c < i; c++) {
      hunks.push(` ${oldLines[c]}`);
    }
    for (let c = i; c < iEnd; c++) {
      hunks.push(`-${oldLines[c]}`);
    }
    for (let c = j; c < jEnd; c++) {
      hunks.push(`+${newLines[c]}`);
    }
    for (let c = iEnd; c < contextEnd; c++) {
      hunks.push(` ${oldLines[c]}`);
    }

    i = contextEnd;
    j = jEnd + (contextEnd - iEnd);
  }

  return { diff: hunks.join("\n"), firstChangedLine };
}

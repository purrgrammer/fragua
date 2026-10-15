/** Byte budget for one free-text field (an error message, a halt detail) on a
 * fact payload. Half the 4 KiB event cap, so the field plus its routing fields
 * always fits. */
export const FACT_TEXT_MAX_BYTES = 2048;

const CLIP_MARKER_PREFIX = " … [clipped ";
const CLIP_MARKER_SUFFIX = " bytes]";

/** Bytes a code point occupies once `JSON.stringify` has escaped it and the
 * result is UTF-8 encoded — what the store's payload cap measures. */
function escapedBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20) return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6;
  if (cp < 0x10000) return 3;
  return 4;
}

function utf8Bytes(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function marker(droppedBytes: number): string {
  return `${CLIP_MARKER_PREFIX}${droppedBytes}${CLIP_MARKER_SUFFIX}`;
}

function markerBytes(m: string): number {
  let n = 0;
  for (const ch of m) n += escapedBytes(ch.codePointAt(0) ?? 0);
  return n;
}

/** Longest code-point-aligned prefix end whose escaped size fits `budget`, and
 * whether the whole string fit. Walks at most `budget` code points. */
function fitEnd(s: string, budget: number): { end: number; whole: boolean } {
  let used = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 0;
    const cost = escapedBytes(cp);
    if (used + cost > budget) return { end: i, whole: false };
    used += cost;
    i += cp > 0xffff ? 2 : 1;
  }
  return { end: i, whole: true };
}

function utf8LengthFrom(s: string, from: number): number {
  let n = 0;
  let i = from;
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 0;
    n += utf8Bytes(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return n;
}

/** Clip free text bound for a fact payload so its JSON-escaped UTF-8 form is at
 * most `maxBytes`, never splitting a surrogate pair. A clipped result ends with
 * a ` … [clipped N bytes]` marker (dropped when the budget can't seat it).
 * Cost is O(maxBytes) for the cut plus one linear pass to size the remainder,
 * so it is safe on unbounded input such as a provider error body. */
export function clipPayloadText(s: string, maxBytes: number = FACT_TEXT_MAX_BYTES): string {
  if (maxBytes <= 0) return "";
  const head = fitEnd(s, maxBytes);
  if (head.whole) return s;
  const reserve = markerBytes(marker(s.length * 3));
  if (reserve >= maxBytes) return s.slice(0, head.end);
  const { end } = fitEnd(s, maxBytes - reserve);
  return s.slice(0, end) + marker(utf8LengthFrom(s, end));
}

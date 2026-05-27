// Secret scrubbing — pure, deterministic text transform.
// No I/O, no clock, no random.

import type { CompiledRegistry } from "./registry.ts";
import { mergeSourcePrecedence } from "./registry.ts";

// ---------------------------------------------------------------------------
// Span collection + merge
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  source: string;
}

/** Sort then union overlapping/adjacent spans into non-overlapping, non-adjacent merged spans. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];

  // Stable sort: by start, then by end desc (wider first on same start).
  spans.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });

  const merged: Span[] = [];
  let cur = { ...spans[0]! };

  for (let i = 1; i < spans.length; i++) {
    const s = spans[i]!;
    if (s.start <= cur.end) {
      // Overlapping or adjacent.
      cur.end = Math.max(cur.end, s.end);
      cur.source = mergeSourcePrecedence(cur.source, s.source);
    } else {
      merged.push(cur);
      cur = { ...s };
    }
  }
  merged.push(cur);

  return merged;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScrubOptions {
  labels?: "source" | "generic";
}

/**
 * Scrub `text` using the compiled registry.
 *
 * - Runs the Aho-Corasick automaton over literal + encoded needles.
 * - Runs each compiled pattern regex.
 * - Merges all spans (overlapping/adjacent → single marker).
 * - Emits `[REDACTED:<source>]` (default) or `[REDACTED]` (generic).
 * - NO length preservation.
 */
export function scrubText(text: string, registry: CompiledRegistry, opts?: ScrubOptions): string {
  const labelMode = opts?.labels ?? "source";

  const spans: Span[] = [];

  // Aho-Corasick scan.
  for (const hit of registry.ac.search(text)) {
    spans.push({ start: hit.start, end: hit.end, source: hit.source });
  }

  // Pattern scan — reset lastIndex before each use (we compiled with /g).
  for (const cp of registry.patterns) {
    cp.re.lastIndex = 0;
    let m = cp.re.exec(text);
    while (m !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, source: cp.source });
      if (m[0].length === 0) {
        // Zero-width match guard — advance to avoid infinite loop.
        cp.re.lastIndex++;
      }
      m = cp.re.exec(text);
    }
  }

  if (spans.length === 0) return text;

  const merged = mergeSpans(spans);

  // Build output — iterate merged spans in order (already sorted by mergeSpans).
  let out = "";
  let pos = 0;

  for (const span of merged) {
    if (pos < span.start) {
      out += text.slice(pos, span.start);
    }
    const marker = labelMode === "generic" ? "[REDACTED]" : `[REDACTED:${span.source}]`;
    out += marker;
    pos = span.end;
  }

  if (pos < text.length) {
    out += text.slice(pos);
  }

  return out;
}

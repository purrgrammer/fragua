// Outputs substitution — `${{ outputs.X.f }}` token resolution.
// Sibling of substitution.ts (which handles `${{ inputs.x }}`).
//
// Token grammar:
//   ${{ outputs.<producer>.<field>[.<subfield>...] }}
//
// Resolution rules (proposal §3 "Consumption and size"):
//   - A scalar leaf → its string value.
//   - A record or array → JSON.stringify of the canonical struct.
//   - A dotted leaf (`outputs.scope.rec.field`) → the inner scalar value.
//   - Unresolved reference → FAIL CLOSED: throw `UnpopulatedOutputError`. The
//     producer emitted nothing on this run path (it never ran, or ran and
//     failed before emitting), so the consuming node fails loudly rather than
//     silently reading "". The failure becomes a recorded fact and replays
//     identically — the read-time populated-guarantee (proposal §1, §3).
//
// Shell-safe mode wraps scalar substitutions in POSIX single quotes (same as
// the inputs substitution path in substitution.ts).

import type { OutputStructValue, OutputsValue } from "../types/outputs.ts";

/** Thrown by `substituteOutputs` when a `${{ outputs.X.f }}` reference cannot
 * resolve at runtime — the producer didn't emit a value on the taken path.
 * Handlers catch it and turn the node into a routable `outcome=fail`. */
export class UnpopulatedOutputError extends Error {
  readonly missing: readonly string[];
  constructor(missing: string[]) {
    super(
      `unpopulated output reference${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} — ` +
        `the producing node did not emit a value on this run path (reads fail closed)`,
    );
    this.name = "UnpopulatedOutputError";
    this.missing = missing;
  }
}

/** Matches `${{ outputs.<producer>.<rest> }}` where <rest> is one or more
 * dot-separated identifiers. The outer group captures the full path including
 * "outputs.". */
export const OUTPUT_REF_RE =
  /\$\{\{\s*outputs\.([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)\s*\}\}/g;

/** Substitute `${{ outputs.X.f... }}` tokens in a template string.
 * `outputs` is a map from producer node id to that node's emitted struct.
 * Any reference that can't be resolved fails closed — collected and thrown as
 * `UnpopulatedOutputError` rather than collapsed to "". Shell quoting is
 * applied to scalar results only. */
export function substituteOutputs(
  template: string,
  outputs: Record<string, OutputsValue>,
  opts: { escapeForShell?: boolean } = {},
): string {
  const { escapeForShell = false } = opts;
  const missing: string[] = [];
  const result = template.replace(OUTPUT_REF_RE, (whole: string, producer: string, rest: string) => {
    const rendered = resolveOutputRef(outputs, producer, rest.split("."), escapeForShell);
    if (rendered === undefined) {
      missing.push(whole.trim());
      return whole;
    }
    return rendered;
  });
  if (missing.length > 0) throw new UnpopulatedOutputError([...new Set(missing)]);
  return result;
}

/** Resolve a single `${{ outputs.<producer>.<segments> }}` reference to its
 * rendered string, or `undefined` when the producer emitted nothing on this
 * path (producer absent, the dotted path doesn't resolve, or the leaf is an
 * optional field emitted as `null`). A real `false`/`0`/`""` value renders to
 * its string — only a genuinely-absent value (missing or `null`) is `undefined`,
 * so the caller's fail-closed check trips on "no value" but never on a falsy
 * scalar. Shared by `substituteOutputs` and the single-pass `substitute`. */
export function resolveOutputRef(
  outputs: Record<string, OutputsValue>,
  producer: string,
  segments: string[],
  escapeForShell: boolean,
): string | undefined {
  const producerVal = outputs[producer];
  if (producerVal === undefined) return undefined;
  const resolved = resolveSegments(producerVal, segments);
  // `undefined` (no such field) and `null` (an optional field emitted as null —
  // i.e. "no value") both fail closed: an unpopulated ref is a node failure,
  // never a silent `"null"` interpolated into the prompt.
  if (resolved === undefined || resolved === null) return undefined;
  return renderValue(resolved, escapeForShell);
}

function resolveSegments(val: OutputStructValue, segments: string[]): OutputStructValue | undefined {
  let cur: OutputStructValue = val;
  for (const seg of segments) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    const next = (cur as Record<string, OutputStructValue>)[seg];
    if (next === undefined) return undefined;
    cur = next;
  }
  return cur;
}

function renderValue(val: OutputStructValue, escapeForShell: boolean): string {
  if (typeof val === "string") {
    return escapeForShell ? shellQuote(val) : val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    const s = String(val);
    return escapeForShell ? shellQuote(s) : s;
  }
  // Record or array → canonical JSON.
  const json = canonicalJson(val);
  return escapeForShell ? shellQuote(json) : json;
}

/** `JSON.stringify` with object keys sorted recursively, so a record/array
 * output renders to identical bytes whatever key order the model emitted —
 * the consuming prompt is then reproducible across runs (the module header's
 * "canonical struct" guarantee). Array order is preserved (it's semantic). */
function canonicalJson(val: OutputStructValue): string {
  return JSON.stringify(canonicalize(val));
}

function canonicalize(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(canonicalize);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      out[key] = canonicalize((val as Record<string, unknown>)[key]);
    }
    return out;
  }
  return val;
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** Every distinct `{ producer, path }` reference in a template string.
 * Used by the validator to hard-error on an undeclared producer/field or a
 * producer that can never reach the consumer (E035), and to warn (W015) when
 * the producer doesn't dominate the consumer's success path.
 * `path` is the dot-split array of segments after the producer id. */
export function outputReferences(template: string): Array<{ producer: string; path: string[] }> {
  const out: Array<{ producer: string; path: string[] }> = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(OUTPUT_REF_RE)) {
    const producer = m[1];
    const rest = m[2];
    if (producer === undefined || rest === undefined) continue;
    const key = `${producer}.${rest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ producer, path: rest.split(".") });
  }
  return out;
}

// Prompt / template substitution. See docs/SPEC.md §3.8.
//
// Two token families:
//   - `${{ inputs.<name> }}` — a typed run input declared in the
//     workflow's `inputs:` block, bound per-run via `--input name=value`
//     (declared defaults ⊕ run-provided).
//   - `${{ outputs.<producer>.<field>[.<subfield>...] }}` — a typed step
//     output emitted by an upstream node. Reads fail closed: an unpopulated
//     ref throws `UnpopulatedOutputError` (→ node failure) rather than
//     collapsing to "". See docs/proposals/structured-outputs.md.
//
// Substitutes in `prompt:` / `text:` / `run:` strings.
//
// Shell-safe mode wraps the substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { OutputsValue } from "../types/outputs.ts";
import { resolveOutputRef, UnpopulatedOutputError } from "./outputs-substitution.ts";

export { outputReferences } from "./outputs-substitution.ts";

export interface SubstitutionArgs {
  /** Resolved `${{ inputs.<name> }}` bindings (defaults ⊕ run-provided).
   * Scalar inputs are strings; object / array inputs are their parsed JSON
   * value, dot-read via `${{ inputs.x.field }}`. */
  inputs?: Record<string, unknown>;
  /** Resolved `${{ outputs.<producer>.<field> }}` bindings.
   * Keyed by producer node id; value is the node's emitted struct. */
  outputs?: Record<string, OutputsValue>;
}

export interface SubstitutionOptions {
  args?: SubstitutionArgs;
  /** If true, wrap substituted values in single quotes for shell safety. */
  escapeForShell?: boolean;
  /** If true, wrap each interpolated `${{ outputs.X.f }}` value in a
   * content-derived delimiter so an upstream-laundered value can't pose as an
   * instruction in an `llm` `prompt:`. Set ONLY for prompt consumption — `tool`
   * `run:` uses `escapeForShell` (a shell-injection surface, not prompt), and
   * `human` `text:` is read by a person. Ignored when `escapeForShell` is set.
   * See docs/proposals/structured-outputs.md §6.4. */
  wrapOutputs?: boolean;
}

/** Boundary tag for an output value interpolated into a prompt. The content
 * hash lives in the element NAME (`<fragua_output_<hash>>…</fragua_output_<hash>>`)
 * so the open/close pair is well-formed XML/HTML — a markdown renderer (the web
 * conversation view) treats it as an unknown element and hides the tags rather
 * than printing a broken `</tag attr="…">` literal. Carrying the hash on the
 * close is what makes break-out a preimage problem: a value can't contain its
 * own closing tag without a SHA-256 preimage of the value. Deterministic, so the
 * same value renders identically on replay. The `fragua_output_` prefix is what
 * the agent's standing system-prompt rule marks as data. */
export function wrapOutputValue(value: string): string {
  const id = sha256Hex(value);
  return `<fragua_output_${id}>${value}</fragua_output_${id}>`;
}

/** SHA-256 of the UTF-8 bytes of `s`, hex-encoded (64 chars). Pure-JS
 * (noble-hashes) so `@fragua/core` stays browser-safe while the delimiter id is
 * preimage-hard — identical bytes to `node:crypto`'s `createHash("sha256")`. */
function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)));
}

/** Matches `${{ inputs.name }}` with surrounding whitespace tolerance.
 * Input names start with a letter and allow word chars + hyphen, matching
 * the parser's `inputs:` key grammar. */
const INPUT_REF_RE = /\$\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)\s*\}\}/g;

/** Matches EITHER token in one pattern, so both families resolve in a single
 * pass over the original template. Group 1 = input name; groups 2+3 = output
 * producer + dotted path. The inputs name allows hyphens; the outputs path does
 * not (identifier-only node ids / field keys) — same grammars as the two
 * single-family regexes. */
const COMBINED_REF_RE =
  /\$\{\{\s*(?:inputs\.([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*)|outputs\.([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*))\s*\}\}/g;

export function substitute(template: string, opts: SubstitutionOptions = {}): string {
  const { args = {}, escapeForShell = false, wrapOutputs = false } = opts;
  const fmt = (raw: string): string => (escapeForShell ? shellQuote(raw) : raw);
  const inputs = args.inputs ?? {};
  const outputs = args.outputs ?? {};
  const missing: string[] = [];
  // ONE pass over the ORIGINAL template: a substituted value is never re-scanned,
  // so an input whose value literally contains `${{ outputs.X.f }}` (or an output
  // value containing `${{ inputs.x }}`) stays literal — each token is resolved
  // exactly once, never cross-injected. Inputs collapse to "" when unbound (the
  // validator flags undeclared refs); outputs FAIL CLOSED — an unresolved ref is
  // collected and thrown as `UnpopulatedOutputError`, which the handlers turn
  // into a node failure rather than a silent "".
  const result = template.replace(
    COMBINED_REF_RE,
    (whole: string, inName: string | undefined, outProducer: string | undefined, outRest: string | undefined) => {
      if (inName !== undefined) return fmt(resolveInputRef(inputs, inName.split(".")));
      const rendered = resolveOutputRef(outputs, outProducer ?? "", (outRest ?? "").split("."), escapeForShell);
      if (rendered === undefined) {
        missing.push(whole.trim());
        return whole;
      }
      return wrapOutputs && !escapeForShell ? wrapOutputValue(rendered) : rendered;
    },
  );
  if (missing.length > 0) throw new UnpopulatedOutputError([...new Set(missing)]);
  return result;
}

/** Resolve a `${{ inputs.<name>[.<field>...] }}` reference to its rendered
 * string. Inputs are LENIENT (unlike fail-closed outputs): an unbound input or
 * an unresolvable dotted path collapses to "" — the validator (E030) flags refs
 * to undeclared inputs separately. A scalar renders verbatim; a whole object /
 * array renders as JSON; a dotted leaf renders its scalar value. */
function resolveInputRef(inputs: Record<string, unknown>, segments: string[]): string {
  const [name, ...rest] = segments;
  if (name === undefined) return "";
  let cur: unknown = inputs[name];
  for (const seg of rest) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return "";
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined || cur === null) return "";
  if (typeof cur === "string") return cur;
  if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
  return JSON.stringify(cur);
}

/** Every `${{ inputs.X[.f...] }}` BASE reference name in a template. Used by the
 * validator (E030) to flag references to undeclared inputs (the base name is
 * what a declaration names; dotted segments address into a record/array). */
export function inputReferences(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(INPUT_REF_RE)) {
    const base = m[1]?.split(".")[0];
    if (base !== undefined && !out.includes(base)) out.push(base);
  }
  return out;
}

/** Wrap a string in POSIX-safe single quotes. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

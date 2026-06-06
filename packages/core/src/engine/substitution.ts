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

import type { OutputsValue } from "../types/outputs.ts";
import { resolveOutputRef, UnpopulatedOutputError } from "./outputs-substitution.ts";

export { outputReferences } from "./outputs-substitution.ts";

export interface SubstitutionArgs {
  /** Resolved `${{ inputs.<name> }}` bindings (defaults ⊕ run-provided). */
  inputs?: Record<string, string>;
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

/** Boundary tag for an output value interpolated into a prompt. The id is a
 * content hash, so a value can't contain its own closing tag (it would need a
 * hash preimage) and the delimiter is collision-free by construction — and
 * deterministic, so the same value renders identically on replay. The stable
 * `fragua_output` name is what the agent's standing system-prompt rule marks as
 * data. Best-effort defense-in-depth, not a cryptographic guarantee. */
export function wrapOutputValue(value: string): string {
  const id = fnv1a64Hex(value);
  return `<fragua_output id="${id}">\n${value}\n</fragua_output id="${id}">`;
}

/** FNV-1a 64-bit → 16 hex chars. Browser-safe + synchronous (core stays free of
 * `node:crypto`); used only to derive a delimiter boundary, not for security. */
function fnv1a64Hex(s: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    hash = (hash ^ BigInt(s.charCodeAt(i))) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Matches `${{ inputs.name }}` with surrounding whitespace tolerance.
 * Input names start with a letter and allow word chars + hyphen, matching
 * the parser's `inputs:` key grammar. */
const INPUT_REF_RE = /\$\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;

/** Matches EITHER token in one pattern, so both families resolve in a single
 * pass over the original template. Group 1 = input name; groups 2+3 = output
 * producer + dotted path. The inputs name allows hyphens; the outputs path does
 * not (identifier-only node ids / field keys) — same grammars as the two
 * single-family regexes. */
const COMBINED_REF_RE =
  /\$\{\{\s*(?:inputs\.([a-zA-Z][a-zA-Z0-9_-]*)|outputs\.([a-zA-Z][a-zA-Z0-9_]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*))\s*\}\}/g;

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
      if (inName !== undefined) return fmt(inputs[inName] ?? "");
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

/** Every `${{ inputs.X }}` reference name in a template. Used by the
 * validator (E030) to flag references to undeclared inputs. */
export function inputReferences(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(INPUT_REF_RE)) {
    const name = m[1];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Wrap a string in POSIX-safe single quotes. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

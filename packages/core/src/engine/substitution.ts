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
  const { args = {}, escapeForShell = false } = opts;
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
      return rendered;
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

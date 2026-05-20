// Prompt / template substitution. See docs/SPEC.md §3.8.
//
// Two token families:
//   - `$ARGUMENTS` — the run's free-form input string (CLI positional or
//     POST /runs `input`).
//   - `${{ inputs.<name> }}` — a typed run input declared in the
//     workflow's `inputs:` block, bound per-run via `--input name=value`.
//
// Both substitute in `prompt:` / `text:` / `run:` strings. Cross-node
// data transfer still happens through shared `thread:` + optional per-node
// `summary:` (SPEC §3.3), not through prompt substitution.
//
// Shell-safe mode wraps the substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

export interface SubstitutionArgs {
  $ARGUMENTS?: string;
  /** Resolved `${{ inputs.<name> }}` bindings (defaults ⊕ run-provided). */
  inputs?: Record<string, string>;
}

export interface SubstitutionOptions {
  args?: SubstitutionArgs;
  /** If true, wrap substituted values in single quotes for shell safety. */
  escapeForShell?: boolean;
}

const BUILTIN_VARS = ["$ARGUMENTS"] as const;

/** Matches `${{ inputs.name }}` with surrounding whitespace tolerance.
 * Input names start with a letter and allow word chars + hyphen, matching
 * the parser's `inputs:` key grammar. */
const INPUT_REF_RE = /\$\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;

export function substitute(template: string, opts: SubstitutionOptions = {}): string {
  const { args = {}, escapeForShell = false } = opts;
  let out = template;
  const fmt = (raw: string): string => (escapeForShell ? shellQuote(raw) : raw);
  for (const tok of BUILTIN_VARS) {
    const key = tok as keyof SubstitutionArgs;
    const v = args[key];
    out = replaceBoundary(out, tok, fmt(typeof v === "string" ? v : ""));
  }
  // `${{ inputs.x }}` references that resolve to a binding substitute;
  // unresolved references collapse to "" (the validator flags undeclared
  // refs at validate-time, so a surviving placeholder here means the
  // input was declared but left unbound and undefaulted).
  const inputs = args.inputs ?? {};
  out = out.replace(INPUT_REF_RE, (_whole, name: string) => fmt(inputs[name] ?? ""));
  return out;
}

/** Collect builtin tokens that a template references. */
export function collectReferences(template: string): { builtins: string[]; inputs: string[] } {
  const builtins: string[] = [];
  for (const tok of BUILTIN_VARS) {
    if (template.includes(tok) && !builtins.includes(tok)) builtins.push(tok);
  }
  return { builtins, inputs: inputReferences(template) };
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

function replaceBoundary(haystack: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![A-Za-z0-9_])`, "g");
  // Callback form: avoids `$&` / `$1` etc. in `replacement` being interpreted
  // as backreferences by String.replace.
  return haystack.replace(re, () => replacement);
}

/** Wrap a string in POSIX-safe single quotes. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

// Prompt / template substitution. See docs/SPEC.md §3.8.
//
// One token family:
//   - `${{ inputs.<name> }}` — a typed run input declared in the
//     workflow's `inputs:` block, bound per-run via `--input name=value`
//     (declared defaults ⊕ run-provided).
//
// Substitutes in `prompt:` / `text:` / `run:` strings. Cross-node data
// transfer still happens through a shared `thread:` + optional per-node
// `summary:` (SPEC §3.3), not through prompt substitution.
//
// Shell-safe mode wraps the substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

export interface SubstitutionArgs {
  /** Resolved `${{ inputs.<name> }}` bindings (defaults ⊕ run-provided). */
  inputs?: Record<string, string>;
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

export function substitute(template: string, opts: SubstitutionOptions = {}): string {
  const { args = {}, escapeForShell = false } = opts;
  const fmt = (raw: string): string => (escapeForShell ? shellQuote(raw) : raw);
  // `${{ inputs.x }}` references that resolve to a binding substitute;
  // unresolved references collapse to "" (the validator flags undeclared
  // refs at validate-time, so a surviving placeholder here means the
  // input was declared but left unbound and undefaulted).
  const inputs = args.inputs ?? {};
  return template.replace(INPUT_REF_RE, (_whole, name: string) => fmt(inputs[name] ?? ""));
}

/** Substitute `${{ inputs.* }}` tokens in an argv vector, per-element.
 *
 * Each element (cmd and every args[i]) is substituted independently;
 * the resolved value becomes exactly one argv token and is NEVER
 * re-split on whitespace or shell-parsed. This is the injection-safety
 * contract for the `exec:` tool-node form: metacharacters in input
 * values (`$()`, backticks, spaces, newlines, quotes) are inert data
 * at the child process boundary because no shell ever sees them.
 *
 * No shell-quoting is applied — the unescaped value goes straight into
 * the argv vector passed to `child_process.spawn`. */
export function substituteArgv(
  parts: { cmd: string; args: string[] },
  opts: { args?: SubstitutionArgs } = {},
): { cmd: string; args: string[] } {
  const inputs = opts.args?.inputs ?? {};
  const replaceToken = (token: string): string =>
    token.replace(INPUT_REF_RE, (_whole, name: string) => inputs[name] ?? "");
  return {
    cmd: replaceToken(parts.cmd),
    args: parts.args.map(replaceToken),
  };
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

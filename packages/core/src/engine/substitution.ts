// Prompt / template substitution. See docs/SPEC.md §3.8.
//
// One token: `$ARGUMENTS` — the run's input string (CLI positional or
// POST /runs body). Cross-node data transfer happens through shared
// threads + fidelity (SPEC §3.3), not through prompt substitution.
//
// Shell-safe mode wraps the substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

export interface SubstitutionArgs {
  $ARGUMENTS?: string;
}

export interface SubstitutionOptions {
  args?: SubstitutionArgs;
  /** If true, wrap substituted values in single quotes for shell safety. */
  escapeForShell?: boolean;
}

const BUILTIN_VARS = ["$ARGUMENTS"] as const;

export function substitute(template: string, opts: SubstitutionOptions = {}): string {
  const { args = {}, escapeForShell = false } = opts;
  let out = template;
  const fmt = (raw: string): string => (escapeForShell ? shellQuote(raw) : raw);
  for (const tok of BUILTIN_VARS) {
    const key = tok as keyof SubstitutionArgs;
    const v = args[key];
    out = replaceBoundary(out, tok, fmt(v ?? ""));
  }
  return out;
}

/** Collect builtin tokens that a template references. */
export function collectReferences(template: string): { builtins: string[] } {
  const builtins: string[] = [];
  for (const tok of BUILTIN_VARS) {
    if (template.includes(tok) && !builtins.includes(tok)) builtins.push(tok);
  }
  return { builtins };
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

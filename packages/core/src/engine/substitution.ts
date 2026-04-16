// Prompt / template substitution. See docs/SPEC.md §3.2.
//
// Supported tokens (in order of longest-prefix-match):
//   ${context.<key>}          — read context KV (dots in key preserved)
//   $<nodeId>.output.<path>   — traverse structured node output (JSON path)
//   $<nodeId>.output          — raw node stdout/response
//   $ARTIFACTS_DIR            — per-run scratchpad directory
//   $LOOP_USER_INPUT          — latest user input in a loop iteration
//   $REJECTION_REASON         — reason for the most recent rejection
//   $ARGUMENTS                — all positional args joined with space
//   $1 … $9                   — individual positional args
//
// Shell-safe mode wraps every substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

import type { ContextMap } from "../types/context.ts";
import type { ContextValue } from "../types/outcome.ts";

export interface NodeOutput {
  success: boolean;
  output: string;
  data?: ContextValue;
  timestamp: number;
}

export interface SubstitutionArgs {
  $1?: string;
  $2?: string;
  $3?: string;
  $4?: string;
  $5?: string;
  $6?: string;
  $7?: string;
  $8?: string;
  $9?: string;
  $ARGUMENTS?: string;
  $ARTIFACTS_DIR?: string;
  $LOOP_USER_INPUT?: string;
  $REJECTION_REASON?: string;
}

export interface SubstitutionOptions {
  context?: ContextMap;
  nodeOutputs?: Map<string, NodeOutput>;
  args?: SubstitutionArgs;
  /** If true, wrap substituted values in single quotes for shell safety. */
  escapeForShell?: boolean;
}

const CONTEXT_RE = /\$\{context\.([^}]+)\}/g;
const NODE_OUTPUT_RE = /\$([A-Za-z_][A-Za-z0-9_-]*)\.output(?:\.([A-Za-z0-9_.[\]-]+))?/g;
// POSITIONAL_VARS handled explicitly to avoid greedy conflicts.
const BUILTIN_VARS = ["$ARTIFACTS_DIR", "$LOOP_USER_INPUT", "$REJECTION_REASON", "$ARGUMENTS"];

export function substitute(template: string, opts: SubstitutionOptions = {}): string {
  const { context = {}, nodeOutputs, args = {}, escapeForShell = false } = opts;
  let out = template;

  const toStr = (v: ContextValue | undefined): string => {
    if (v === undefined) return "";
    if (v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return JSON.stringify(v);
  };

  const fmt = (raw: string): string => (escapeForShell ? shellQuote(raw) : raw);

  // ${context.x} — longest-wins since the regex greedily matches until '}'
  out = out.replace(CONTEXT_RE, (_match, key: string) => {
    const trimmed = key.trim();
    if (!(trimmed in context)) return fmt("");
    return fmt(toStr(context[trimmed]));
  });

  // $nodeId.output[.path]
  out = out.replace(NODE_OUTPUT_RE, (_match, nodeId: string, path: string | undefined) => {
    const no = nodeOutputs?.get(nodeId);
    if (!no) return fmt("");
    if (!path) return fmt(no.output);
    const value = traverse(no.data, path);
    return fmt(toStr(value as ContextValue | undefined));
  });

  // Positional $1..$9 (replace before $ARGUMENTS to avoid clobber)
  for (let i = 1; i <= 9; i++) {
    const key = `$${i}` as keyof SubstitutionArgs;
    const v = args[key];
    if (v === undefined) continue;
    // Replace only \bN boundary — DOT attribute names don't contain $ so we use
    // a simple textual replace with a negative lookahead for digits.
    out = replaceBoundary(out, `$${i}`, fmt(v));
  }

  // Builtin tokens
  for (const tok of BUILTIN_VARS) {
    const key = tok as keyof SubstitutionArgs;
    const v = args[key];
    if (v === undefined) {
      out = replaceBoundary(out, tok, fmt(""));
    } else {
      out = replaceBoundary(out, tok, fmt(v));
    }
  }

  return out;
}

/** Collect all referenced names that a template requires, so validators can
 * flag unresolved references pre-execution. */
export function collectReferences(template: string): {
  contextKeys: string[];
  nodeIds: string[];
  builtins: string[];
} {
  const contextKeys: string[] = [];
  const nodeIds: string[] = [];
  const builtins: string[] = [];

  for (const m of template.matchAll(CONTEXT_RE)) {
    const key = m[1]?.trim();
    if (key && !contextKeys.includes(key)) contextKeys.push(key);
  }
  for (const m of template.matchAll(NODE_OUTPUT_RE)) {
    const id = m[1];
    if (id && !nodeIds.includes(id)) nodeIds.push(id);
  }
  for (const tok of BUILTIN_VARS) {
    if (template.includes(tok) && !builtins.includes(tok)) builtins.push(tok);
  }
  return { contextKeys, nodeIds, builtins };
}

function traverse(data: ContextValue | undefined, path: string): ContextValue | undefined {
  if (data === undefined || data === null) return undefined;
  const segments = path.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== "");
  let cur: ContextValue | undefined = data;
  for (const seg of segments) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, ContextValue>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function replaceBoundary(haystack: string, needle: string, replacement: string): string {
  // Use a regex with lookahead to avoid matching $1 inside $10 etc. Since our
  // token set is fixed and tokens are always followed by non-ident/non-digit
  // characters or end-of-string, we replace textually with a boundary check.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![A-Za-z0-9_])`, "g");
  return haystack.replace(re, replacement);
}

/** Wrap a string in POSIX-safe single quotes. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

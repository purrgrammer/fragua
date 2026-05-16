// Prompt / template substitution. See docs/SPEC.md §3.2.
//
// Supported tokens (in order of longest-prefix-match):
//   ${context.<key>}          — read context KV (dots in key preserved)
//   $<nodeId>.output.<path>   — traverse structured node output (JSON path)
//   $<nodeId>.output          — raw node stdout/response
//   $<nodeId>.stderr          — node stderr channel (tool nodes only; empty otherwise)
//   $ARGUMENTS                — the run's input string (CLI positional / API body)
//   $goal                     — the graph's `goal` attribute (attractor §9.2)
//
// Shell-safe mode wraps every substituted value in single quotes, escaping
// embedded quotes per POSIX (close quote, escaped quote, reopen).

import type { ContextMap } from "../types/context.ts";
import type { ContextValue } from "../types/outcome.ts";

export interface NodeOutput {
  success: boolean;
  output: string;
  /** Optional stderr channel. Populated for tool nodes; undefined for codergen/other nodes. */
  stderr?: string;
  data?: ContextValue;
  timestamp: number;
}

export interface SubstitutionArgs {
  $ARGUMENTS?: string;
}

export interface SubstitutionOptions {
  context?: ContextMap;
  nodeOutputs?: ReadonlyMap<string, NodeOutput>;
  args?: SubstitutionArgs;
  /** If true, wrap substituted values in single quotes for shell safety. */
  escapeForShell?: boolean;
}

const CONTEXT_RE = /\$\{context\.([^}]+)\}/g;
// Matches $<nodeId>.output[.path] and $<nodeId>.stderr — channel is capture group 2.
// JSON-path traversal (group 3) is supported for .output only; .stderr is always a flat string.
const NODE_CHANNEL_RE = /\$([A-Za-z_][A-Za-z0-9_-]*)\.(output|stderr)(?:\.([A-Za-z0-9_.[\]-]+))?/g;
const BUILTIN_VARS = ["$ARGUMENTS"] as const;

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

  // $nodeId.output[.path] and $nodeId.stderr
  out = out.replace(NODE_CHANNEL_RE, (_match, nodeId: string, channel: string, path: string | undefined) => {
    const no = nodeOutputs?.get(nodeId);
    if (!no) return fmt("");
    if (channel === "stderr") return fmt(no.stderr ?? "");
    // channel === "output"
    if (!path) return fmt(no.output);
    const value = traverse(no.data, path);
    return fmt(toStr(value as ContextValue | undefined));
  });

  // Builtin tokens
  for (const tok of BUILTIN_VARS) {
    const key = tok as keyof SubstitutionArgs;
    const v = args[key];
    out = replaceBoundary(out, tok, fmt(v ?? ""));
  }

  // $goal — pulled from routing-mirrored `graph.goal`. Per attractor
  // §9.2 this is the canonical workflow-goal substitution.
  const goal = context["graph.goal"];
  out = replaceBoundary(out, "$goal", fmt(toStr(goal)));

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
  for (const m of template.matchAll(NODE_CHANNEL_RE)) {
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
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?![A-Za-z0-9_])`, "g");
  return haystack.replace(re, replacement);
}

/** Wrap a string in POSIX-safe single quotes. */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

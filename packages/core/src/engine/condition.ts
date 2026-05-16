// Condition expression parser + evaluator.
// Grammar:
//   expr    := or
//   or      := and ("||" and)*
//   and     := unary ("&&" unary)*
//   unary   := "!" unary | primary
//   primary := "(" expr ")" | term
//   term    := path (op value | "contains" value | "matches" regex)?
//   path    := IDENT ("." IDENT)*   (also accepts "." inside key for context.x.y)
//   op      := "=" | "!=" | "<" | ">" | "<=" | ">="
//   value   := STRING | NUMBER | IDENT | "true" | "false" | "null"
//   regex   := "/" body "/" flags?
//   flags   := [gimsuy]+
//
// Evaluation environment:
//   env.outcome : the current outcome status (e.g. "success")
//   env.context : the run context KV map (flat Record)
//
// Path semantics:
//   outcome          → env.outcome (string)
//   context.<key>    → env.context[key]   where <key> keeps dots (e.g. "graph.goal")
//   <anything else>  → evaluates to undefined (and therefore fails `=` checks)
//
// Operator semantics:
//   <, >, <=, >=  : numeric coercion both sides; lexicographic fallback for strings
//   contains      : substring test (string LHS) or membership test (array LHS)
//   matches       : regex test; RHS is /pattern/ or /pattern/flags
//   !             : negation; binds tighter than && which binds tighter than ||
//
// See docs/SPEC.md §3.8.

import {
  type AndNode,
  type ComparisonNode,
  type ConditionAst,
  ConditionParseError,
  type ConditionValue,
  type ContainsNode,
  type MatchesNode,
  type NotNode,
  type OrNode,
  type TruthyNode,
} from "../types/condition.ts";
import type { ContextValue } from "../types/outcome.ts";

// -------------------- Parser --------------------

interface LexerState {
  i: number;
  input: string;
}

function skipSpace(st: LexerState): void {
  while (st.i < st.input.length) {
    const c = st.input[st.i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") st.i++;
    else break;
  }
}

function peek(st: LexerState): string | undefined {
  return st.input[st.i];
}

function consumeLiteral(st: LexerState, lit: string): boolean {
  if (st.input.startsWith(lit, st.i)) {
    st.i += lit.length;
    return true;
  }
  return false;
}

function parseIdent(st: LexerState): string {
  const start = st.i;
  while (st.i < st.input.length) {
    const c = st.input[st.i];
    if (c === undefined) break;
    const isAlpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    const isDigit = c >= "0" && c <= "9";
    if (isAlpha || isDigit || c === "_" || c === "-") {
      st.i++;
    } else {
      break;
    }
  }
  if (st.i === start) {
    throw new ConditionParseError("expected identifier", st.i, st.input);
  }
  return st.input.slice(start, st.i);
}

/** Non-destructive keyword probe: returns true and advances st.i past the
 * keyword if the next non-space token is exactly `kw`. Restores st.i on miss. */
function tryKeyword(st: LexerState, kw: string): boolean {
  const saved = st.i;
  skipSpace(st);
  const start = st.i;
  while (st.i < st.input.length) {
    const c = st.input[st.i];
    if (c === undefined) break;
    const isAlpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    if (isAlpha) st.i++;
    else break;
  }
  const word = st.input.slice(start, st.i);
  if (word === kw) return true;
  st.i = saved;
  return false;
}

function parsePath(st: LexerState): string[] {
  const parts: string[] = [parseIdent(st)];
  while (peek(st) === ".") {
    st.i++;
    parts.push(parseIdent(st));
  }
  return parts;
}

function parseString(st: LexerState): string {
  if (peek(st) !== '"') throw new ConditionParseError("expected quoted string", st.i, st.input);
  st.i++;
  let out = "";
  while (st.i < st.input.length && peek(st) !== '"') {
    const c = st.input[st.i]!;
    if (c === "\\" && st.i + 1 < st.input.length) {
      const n = st.input[st.i + 1]!;
      if (n === '"' || n === "\\") {
        out += n;
        st.i += 2;
        continue;
      }
      if (n === "n") {
        out += "\n";
        st.i += 2;
        continue;
      }
      if (n === "t") {
        out += "\t";
        st.i += 2;
        continue;
      }
      out += c;
      st.i++;
      continue;
    }
    out += c;
    st.i++;
  }
  if (peek(st) !== '"') throw new ConditionParseError("unterminated string", st.i, st.input);
  st.i++;
  return out;
}

function parseValue(st: LexerState): ConditionValue {
  skipSpace(st);
  const c = peek(st);
  if (c === '"') return parseString(st);
  if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
    const start = st.i;
    if (c === "-") st.i++;
    while (st.i < st.input.length) {
      const d = st.input[st.i];
      if (d === undefined) break;
      if ((d >= "0" && d <= "9") || d === ".") st.i++;
      else break;
    }
    const n = Number.parseFloat(st.input.slice(start, st.i));
    if (!Number.isFinite(n)) throw new ConditionParseError("invalid number", start, st.input);
    return n;
  }
  const ident = parseIdent(st);
  if (ident === "true") return true;
  if (ident === "false") return false;
  if (ident === "null") return null;
  return ident; // bareword compared as string
}

/** Parse a /pattern/flags regex literal. Called after "matches" keyword consumed. */
function parseRegex(st: LexerState): { pattern: string; flags: string } {
  skipSpace(st);
  const slashPos = st.i;
  if (!consumeLiteral(st, "/")) {
    throw new ConditionParseError("expected '/' to start regex literal", slashPos, st.input);
  }
  let pattern = "";
  while (st.i < st.input.length) {
    const c = st.input[st.i]!;
    if (c === "/") break;
    if (c === "\\" && st.i + 1 < st.input.length) {
      const n = st.input[st.i + 1]!;
      pattern += c + n;
      st.i += 2;
      continue;
    }
    pattern += c;
    st.i++;
  }
  if (!consumeLiteral(st, "/")) {
    throw new ConditionParseError("unterminated regex literal (missing closing '/')", st.i, st.input);
  }
  // Collect optional flags: letters only
  let flags = "";
  while (st.i < st.input.length) {
    const c = st.input[st.i]!;
    const isAlpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    if (isAlpha) {
      flags += c;
      st.i++;
    } else break;
  }
  // Validate the regex eagerly so parse errors surface at parse time.
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConditionParseError(`invalid regex: ${msg}`, slashPos, st.input);
  }
  return { pattern, flags };
}

function parseTerm(st: LexerState): ComparisonNode | ContainsNode | MatchesNode | TruthyNode {
  skipSpace(st);
  const path = parsePath(st);
  skipSpace(st);

  // Two-character operators first (must precede single-char checks).
  if (consumeLiteral(st, "<=")) {
    skipSpace(st);
    return { kind: "cmp", path, op: "<=", value: parseValue(st) };
  }
  if (consumeLiteral(st, ">=")) {
    skipSpace(st);
    return { kind: "cmp", path, op: ">=", value: parseValue(st) };
  }
  if (consumeLiteral(st, "!=")) {
    skipSpace(st);
    return { kind: "cmp", path, op: "!=", value: parseValue(st) };
  }
  if (consumeLiteral(st, "=")) {
    skipSpace(st);
    return { kind: "cmp", path, op: "=", value: parseValue(st) };
  }
  if (consumeLiteral(st, "<")) {
    skipSpace(st);
    return { kind: "cmp", path, op: "<", value: parseValue(st) };
  }
  if (consumeLiteral(st, ">")) {
    skipSpace(st);
    return { kind: "cmp", path, op: ">", value: parseValue(st) };
  }
  if (tryKeyword(st, "contains")) {
    skipSpace(st);
    return { kind: "contains", path, value: parseValue(st) };
  }
  if (tryKeyword(st, "matches")) {
    return { kind: "matches", path, ...parseRegex(st) };
  }

  // Bare-key truthiness (attractor §10.5).
  return { kind: "truthy", path };
}

function parsePrimary(st: LexerState): ConditionAst {
  skipSpace(st);
  if (consumeLiteral(st, "(")) {
    const inner = parseOr(st);
    skipSpace(st);
    if (!consumeLiteral(st, ")")) {
      throw new ConditionParseError("expected ')'", st.i, st.input);
    }
    return inner;
  }
  return parseTerm(st);
}

function parseUnary(st: LexerState): ConditionAst {
  skipSpace(st);
  // Consume "!" only when not followed by "=" (which would be "!=", handled in parseTerm).
  if (peek(st) === "!" && st.input[st.i + 1] !== "=") {
    st.i++;
    const expr = parseUnary(st);
    return { kind: "not", expr } satisfies NotNode;
  }
  return parsePrimary(st);
}

function parseAnd(st: LexerState): ConditionAst {
  let left: ConditionAst = parseUnary(st);
  while (true) {
    skipSpace(st);
    if (!consumeLiteral(st, "&&")) break;
    const right = parseUnary(st);
    left = { kind: "and", left, right } satisfies AndNode;
  }
  return left;
}

function parseOr(st: LexerState): ConditionAst {
  let left: ConditionAst = parseAnd(st);
  while (true) {
    skipSpace(st);
    if (!consumeLiteral(st, "||")) break;
    const right = parseAnd(st);
    left = { kind: "or", left, right } satisfies OrNode;
  }
  return left;
}

function parseExpr(st: LexerState): ConditionAst {
  return parseOr(st);
}

export function parseCondition(source: string): ConditionAst {
  const st: LexerState = { i: 0, input: source };
  const ast = parseExpr(st);
  skipSpace(st);
  if (st.i !== source.length) {
    throw new ConditionParseError(`unexpected trailing input "${source.slice(st.i)}"`, st.i, source);
  }
  return ast;
}

// -------------------- Evaluator --------------------

export interface ConditionEnv {
  outcome: string;
  context: Record<string, ContextValue>;
  /** Outcome's preferred_label (attractor §10.4 — recognised top-level
   * key alongside `outcome` and `context.<path>`). Optional; absent
   * defaults to the empty string. */
  preferred_label?: string;
}

/** Resolve a path against the environment. Returns `undefined` if missing.
 * Recognised top-level keys (attractor §10.4):
 *   - `outcome`         → env.outcome
 *   - `preferred_label` → env.preferred_label ?? ""
 *   - `context.<path>`  → env.context["<path>"]
 *   - bare unqualified  → env.context[<path>] (per §10.5 "Unqualified keys
 *                          evaluate against context")
 */
export function resolvePath(path: string[], env: ConditionEnv): ContextValue | undefined {
  const [first, ...rest] = path;
  if (first === undefined) return undefined;
  if (first === "outcome") {
    if (rest.length === 0) return env.outcome;
    return undefined; // outcome is a flat string, no sub-paths
  }
  if (first === "preferred_label") {
    if (rest.length === 0) return env.preferred_label ?? "";
    return undefined;
  }
  if (first === "context") {
    const key = rest.join(".");
    if (key === "") return undefined;
    const v = env.context[key];
    return v === undefined ? undefined : (v as ContextValue);
  }
  // Unqualified key — treat as context lookup per §10.5.
  const key = path.join(".");
  const v = env.context[key];
  return v === undefined ? undefined : (v as ContextValue);
}

function equals(a: ContextValue | undefined, b: ConditionValue): boolean {
  // Missing key compares as empty string per attractor §10.4–§10.5.
  if (a === undefined) {
    if (b === null) return false;
    if (typeof b === "string") return b === "";
    return false;
  }
  if (b === null) return a === null;
  if (typeof a === "boolean" || typeof b === "boolean") {
    // coerce strings "true"/"false" to booleans when compared to a boolean
    const ab = typeof a === "boolean" ? a : a === "true" ? true : a === "false" ? false : a;
    const bb = typeof b === "boolean" ? b : b === "true" ? true : b === "false" ? false : b;
    return ab === bb;
  }
  if (typeof a === "number" && typeof b === "string") {
    const n = Number.parseFloat(b);
    if (Number.isFinite(n)) return a === n;
    return false;
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = Number.parseFloat(a);
    if (Number.isFinite(n)) return n === b;
    return false;
  }
  return a === b;
}

/** Order comparison helper. Coerces both sides to numbers when possible;
 * falls back to lexicographic string comparison. */
function compareOrder(a: ContextValue | undefined, b: ConditionValue, op: "<" | ">" | "<=" | ">="): boolean {
  if (a === undefined || a === null || b === null) return false;
  if (typeof a === "boolean" || typeof b === "boolean") return false;

  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);

  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (op === "<") return na < nb;
    if (op === ">") return na > nb;
    if (op === "<=") return na <= nb;
    return na >= nb;
  }

  // Lexicographic fallback — coerce both to strings.
  const sa = String(a);
  const sb = String(b);
  if (op === "<") return sa < sb;
  if (op === ">") return sa > sb;
  if (op === "<=") return sa <= sb;
  return sa >= sb;
}

/** Truthiness check for bare-key clauses (attractor §10.5). */
function isTruthy(v: ContextValue | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v !== "";
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v).length > 0;
}

/** Cache compiled regexes across evaluations of the same MatchesNode. */
const regexCache = new WeakMap<object, RegExp>();

export function evaluateCondition(ast: ConditionAst, env: ConditionEnv): boolean {
  if (ast.kind === "or") {
    return evaluateCondition(ast.left, env) || evaluateCondition(ast.right, env);
  }
  if (ast.kind === "and") {
    return evaluateCondition(ast.left, env) && evaluateCondition(ast.right, env);
  }
  if (ast.kind === "not") {
    return !evaluateCondition(ast.expr, env);
  }
  if (ast.kind === "truthy") {
    return isTruthy(resolvePath(ast.path, env));
  }
  if (ast.kind === "contains") {
    const lhs = resolvePath(ast.path, env);
    if (lhs === undefined || lhs === null) return false;
    if (typeof lhs === "string") return lhs.includes(String(ast.value));
    if (Array.isArray(lhs)) return lhs.some((x) => x === ast.value);
    return false;
  }
  if (ast.kind === "matches") {
    const lhs = resolvePath(ast.path, env);
    if (lhs === undefined || lhs === null) return false;
    let re = regexCache.get(ast);
    if (!re) {
      re = new RegExp(ast.pattern, ast.flags);
      regexCache.set(ast, re);
    }
    return re.test(String(lhs));
  }
  // ast.kind === "cmp"
  const lhs = resolvePath(ast.path, env);
  if (ast.op === "=") return equals(lhs, ast.value);
  if (ast.op === "!=") return !equals(lhs, ast.value);
  return compareOrder(lhs, ast.value, ast.op);
}

/** True when a condition string is absent or whitespace-only. */
export function isEmptyCondition(cond: string | undefined): boolean {
  return !cond || cond.trim() === "";
}

/** Convenience: parse + evaluate in one call. Returns `true` for empty
 * strings — an absent `condition` attr doesn't gate the edge. */
export function evaluateConditionSource(source: string, env: ConditionEnv): boolean {
  if (isEmptyCondition(source)) return true;
  return evaluateCondition(parseCondition(source), env);
}

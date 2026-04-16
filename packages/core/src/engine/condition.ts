// Condition expression parser + evaluator.
// Grammar: expr := term ("&&" term)*
//          term := path op value
//          path := IDENT ("." IDENT)*   (also accepts "." inside key for context.x.y)
//          op := "=" | "!="
//          value := STRING | NUMBER | IDENT | "true" | "false" | "null"
//
// Evaluation environment:
//   env.outcome : the current outcome status (e.g. "success")
//   env.context : the pipeline context KV map (flat Record)
//
// Path semantics:
//   outcome          → env.outcome (string)
//   context.<key>    → env.context[key]   where <key> keeps dots (e.g. "graph.goal")
//   <anything else>  → evaluates to undefined (and therefore fails `=` checks)
//
// See docs/SPEC.md §3.8.

import {
  type AndNode,
  type ComparisonNode,
  type ConditionAst,
  ConditionParseError,
  type ConditionValue,
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

function parseTerm(st: LexerState): ComparisonNode {
  skipSpace(st);
  const path = parsePath(st);
  skipSpace(st);
  let op: "=" | "!=";
  if (consumeLiteral(st, "!=")) op = "!=";
  else if (consumeLiteral(st, "=")) op = "=";
  else throw new ConditionParseError("expected `=` or `!=`", st.i, st.input);
  skipSpace(st);
  const value = parseValue(st);
  return { kind: "cmp", path, op, value };
}

function parseExpr(st: LexerState): ConditionAst {
  let left: ConditionAst = parseTerm(st);
  while (true) {
    skipSpace(st);
    if (!consumeLiteral(st, "&&")) break;
    const right = parseTerm(st);
    left = { kind: "and", left, right } satisfies AndNode;
  }
  skipSpace(st);
  return left;
}

export function parseCondition(source: string): ConditionAst {
  const st: LexerState = { i: 0, input: source };
  const ast = parseExpr(st);
  if (st.i !== source.length) {
    throw new ConditionParseError(`unexpected trailing input "${source.slice(st.i)}"`, st.i, source);
  }
  return ast;
}

// -------------------- Evaluator --------------------

export interface ConditionEnv {
  outcome: string;
  context: Record<string, ContextValue>;
}

/** Resolve a path against the environment. Returns `undefined` if missing. */
export function resolvePath(path: string[], env: ConditionEnv): ContextValue | undefined {
  const [first, ...rest] = path;
  if (first === undefined) return undefined;
  if (first === "outcome") {
    if (rest.length === 0) return env.outcome;
    return undefined; // outcome is a flat string, no sub-paths
  }
  if (first === "context") {
    const key = rest.join(".");
    if (key === "") return undefined;
    const v = env.context[key];
    return v === undefined ? undefined : (v as ContextValue);
  }
  return undefined;
}

function equals(a: ContextValue | undefined, b: ConditionValue): boolean {
  if (a === undefined) return b === null; // undefined == null comparison: only matches when rhs is null
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

export function evaluateCondition(ast: ConditionAst, env: ConditionEnv): boolean {
  if (ast.kind === "and") {
    return evaluateCondition(ast.left, env) && evaluateCondition(ast.right, env);
  }
  const lhs = resolvePath(ast.path, env);
  const eq = equals(lhs, ast.value);
  return ast.op === "=" ? eq : !eq;
}

/** True when a condition string is absent or whitespace-only. */
export function isEmptyCondition(cond: string | undefined): boolean {
  return !cond || cond.trim() === "";
}

/** Convenience: parse + evaluate in one call. Returns `true` for empty strings
 * (matching Attractor's convention that an absent `condition` attr does not
 * gate the edge). */
export function evaluateConditionSource(source: string, env: ConditionEnv): boolean {
  if (isEmptyCondition(source)) return true;
  return evaluateCondition(parseCondition(source), env);
}

// Condition AST: the tiny boolean language used on edges.
// Grammar:
//   expr    := or
//   or      := and ("||" and)*
//   and     := unary ("&&" unary)*
//   unary   := "!" unary | primary
//   primary := "(" expr ")" | term
//   term    := path (op value | "contains" value | "matches" regex)?
//   path    := IDENT ("." IDENT)*
//   op      := "=" | "!=" | "<" | ">" | "<=" | ">="
//   value   := STRING | NUMBER | IDENT | "true" | "false" | "null"
//   regex   := "/" body "/" flags?
//   flags   := [gimsuy]+
// See docs/SPEC.md §3.8.

export type ConditionAst = AndNode | OrNode | NotNode | ComparisonNode | ContainsNode | MatchesNode | TruthyNode;

export interface AndNode {
  kind: "and";
  left: ConditionAst;
  right: ConditionAst;
}

export interface OrNode {
  kind: "or";
  left: ConditionAst;
  right: ConditionAst;
}

export interface NotNode {
  kind: "not";
  expr: ConditionAst;
}

export interface ComparisonNode {
  kind: "cmp";
  path: string[];
  op: "=" | "!=" | "<" | ">" | "<=" | ">=";
  value: ConditionValue;
}

export interface ContainsNode {
  kind: "contains";
  path: string[];
  value: ConditionValue;
}

export interface MatchesNode {
  kind: "matches";
  path: string[];
  pattern: string;
  flags: string;
}

/** Bare-key truthiness clause (attractor §10.5 "Unqualified keys evaluate
 * against context"). Resolves the path; truthy iff the resolved value is a
 * non-empty string, a non-zero number, true, or a non-empty array/object. */
export interface TruthyNode {
  kind: "truthy";
  path: string[];
}

export type ConditionValue = string | number | boolean | null;

export class ConditionParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly input: string,
  ) {
    super(`${message} at position ${position} in "${input}"`);
    this.name = "ConditionParseError";
  }
}

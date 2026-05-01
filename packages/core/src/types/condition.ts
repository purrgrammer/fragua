// Condition AST: the tiny boolean language used on edges.
// Grammar: expr := term ("&&" term)*
//          term := ident ("=" | "!=") value
//          ident := (IDENT ".")* IDENT
//          value := STRING | NUMBER | IDENT | "true" | "false" | "null"
// See docs/SPEC.md §3.8.

export type ConditionAst = AndNode | ComparisonNode | TruthyNode;

export interface AndNode {
  kind: "and";
  left: ConditionAst;
  right: ConditionAst;
}

export interface ComparisonNode {
  kind: "cmp";
  path: string[];
  op: "=" | "!=";
  value: ConditionValue;
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

// Condition AST: the tiny boolean language used on edges.
// Grammar: expr := term ("&&" term)*
//          term := ident ("=" | "!=") value
//          ident := (IDENT ".")* IDENT
//          value := STRING | NUMBER | IDENT | "true" | "false" | "null"
// See docs/SPEC.md §3.8.

export type ConditionAst = AndNode | ComparisonNode;

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

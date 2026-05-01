// Model stylesheet parser + apply transform — attractor-spec §8.
//
// Grammar:
//   Stylesheet ::= Rule+
//   Rule       ::= Selector "{" Decl (";" Decl)* ";"? "}"
//   Selector   ::= "*" | Identifier | "." ClassName | "#" NodeId
//   Decl       ::= Property ":" Value
//   Property   ::= "llm_model" | "llm_provider" | "reasoning_effort"
//
// Specificity (lowest → highest):
//   0  *
//   1  shape (e.g. `box`)
//   2  class (e.g. `.code`)
//   3  id    (e.g. `#critical_review`)
//
// Apply order: matching rules are sorted ascending by specificity, then by
// declaration order; each rule's decls merge into the node ONLY when the
// node lacks the property explicitly. Per attractor §8.5, explicit node
// attributes always win.

import type { Graph, Node, NodeAttrs, NodeShape } from "../types/graph.ts";

export type Selector =
  | { kind: "universal" }
  | { kind: "shape"; value: NodeShape | string }
  | { kind: "class"; value: string }
  | { kind: "id"; value: string };

export interface StylesheetRule {
  selector: Selector;
  /** Specificity tier. 0 (universal) → 3 (id). */
  specificity: 0 | 1 | 2 | 3;
  /** Declarations in source order. */
  decls: Record<string, string>;
}

export class StylesheetParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly source: string,
  ) {
    super(`${message} at position ${position} in stylesheet`);
    this.name = "StylesheetParseError";
  }
}

const RECOGNISED_PROPERTIES = new Set(["llm_model", "llm_provider", "reasoning_effort"]);

/** Strip `// line` and `/* block *​/` comments. Preserves source positions
 * by replacing comment characters with spaces (so error positions still
 * point at the offending byte in the original source). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      out += "  ";
      i += 2;
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (src[i] === "/" && src[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

interface LexerState {
  i: number;
  source: string;
}

function skipSpace(st: LexerState): void {
  while (st.i < st.source.length) {
    const c = st.source[st.i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") st.i++;
    else break;
  }
}

function parseIdent(st: LexerState): string {
  const start = st.i;
  while (st.i < st.source.length) {
    const c = st.source[st.i];
    if (c === undefined) break;
    const isAlpha = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
    const isDigit = c >= "0" && c <= "9";
    if (isAlpha || isDigit || c === "_" || c === "-" || c === ".") {
      st.i++;
    } else {
      break;
    }
  }
  if (st.i === start) {
    throw new StylesheetParseError("expected identifier", st.i, st.source);
  }
  return st.source.slice(start, st.i);
}

function parseSelector(st: LexerState): { selector: Selector; specificity: 0 | 1 | 2 | 3 } {
  skipSpace(st);
  const c = st.source[st.i];
  if (c === "*") {
    st.i++;
    return { selector: { kind: "universal" }, specificity: 0 };
  }
  if (c === ".") {
    st.i++;
    const value = parseIdent(st);
    return { selector: { kind: "class", value }, specificity: 2 };
  }
  if (c === "#") {
    st.i++;
    const value = parseIdent(st);
    return { selector: { kind: "id", value }, specificity: 3 };
  }
  const value = parseIdent(st);
  return { selector: { kind: "shape", value }, specificity: 1 };
}

function parseDecl(st: LexerState): [string, string] {
  skipSpace(st);
  const property = parseIdent(st);
  if (!RECOGNISED_PROPERTIES.has(property)) {
    throw new StylesheetParseError(
      `unknown property "${property}" (allowed: llm_model, llm_provider, reasoning_effort)`,
      st.i,
      st.source,
    );
  }
  skipSpace(st);
  if (st.source[st.i] !== ":") {
    throw new StylesheetParseError(`expected ":" after property "${property}"`, st.i, st.source);
  }
  st.i++;
  skipSpace(st);
  // Value: bare token, semi/brace-terminated. Strip surrounding quotes.
  let value = "";
  if (st.source[st.i] === '"') {
    st.i++;
    while (st.i < st.source.length && st.source[st.i] !== '"') {
      value += st.source[st.i];
      st.i++;
    }
    if (st.source[st.i] !== '"') {
      throw new StylesheetParseError("unterminated string in declaration value", st.i, st.source);
    }
    st.i++;
  } else {
    while (st.i < st.source.length) {
      const ch = st.source[st.i];
      if (ch === ";" || ch === "}") break;
      value += ch;
      st.i++;
    }
    value = value.trim();
  }
  if (value === "") {
    throw new StylesheetParseError(`empty value for property "${property}"`, st.i, st.source);
  }
  return [property, value];
}

export function parseStylesheet(source: string): StylesheetRule[] {
  const trimmed = stripComments(source).trim();
  if (trimmed === "") return [];
  const st: LexerState = { i: 0, source: stripComments(source) };
  const rules: StylesheetRule[] = [];
  while (true) {
    skipSpace(st);
    if (st.i >= st.source.length) break;
    const { selector, specificity } = parseSelector(st);
    skipSpace(st);
    if (st.source[st.i] !== "{") {
      throw new StylesheetParseError(`expected "{" after selector`, st.i, st.source);
    }
    st.i++;
    const decls: Record<string, string> = {};
    while (true) {
      skipSpace(st);
      if (st.source[st.i] === "}") {
        st.i++;
        break;
      }
      const [k, v] = parseDecl(st);
      decls[k] = v;
      skipSpace(st);
      if (st.source[st.i] === ";") {
        st.i++;
        continue;
      }
      if (st.source[st.i] === "}") {
        st.i++;
        break;
      }
      throw new StylesheetParseError(`expected ";" or "}" in declaration block`, st.i, st.source);
    }
    rules.push({ selector, specificity, decls });
  }
  return rules;
}

/** True iff `selector` matches `node`. */
export function selectorMatches(selector: Selector, node: Node): boolean {
  if (selector.kind === "universal") return true;
  if (selector.kind === "id") return node.id === selector.value;
  if (selector.kind === "shape") return node.shape === selector.value;
  // class
  if (node.classes.includes(selector.value)) return true;
  // Also accept the explicit `class` attr (comma-separated) — derived
  // classes from subgraph membership end up in `node.classes`, but a
  // node-level `class="planning,critical"` is split there too.
  return false;
}

/** Apply a parsed stylesheet to a graph, mutating in place. Per §8.5 only
 * fills properties the node lacks explicitly. Higher specificity wins;
 * within the same specificity tier the LATER rule wins (matches CSS
 * cascade — author can re-order to override).
 *
 * Implementation walks rules in DESCENDING specificity order (latest
 * source-order first within a tier). Each property is set only when the
 * target attribute is still undefined — explicit node attrs and earlier
 * (higher-spec) stylesheet matches both block lower-spec rules from
 * overriding. */
export function applyStylesheet(graph: Graph, rules: StylesheetRule[]): Graph {
  if (rules.length === 0) return graph;
  for (const node of Object.values(graph.nodes)) {
    const matched = rules
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => selectorMatches(r.selector, node))
      .sort((a, b) => b.r.specificity - a.r.specificity || b.idx - a.idx);
    for (const { r } of matched) {
      for (const [k, v] of Object.entries(r.decls)) {
        if ((node.attrs as NodeAttrs)[k] === undefined) {
          (node.attrs as Record<string, unknown>)[k] = v;
        }
      }
    }
  }
  return graph;
}

/** Convenience: parse + apply in one call. Returns parse errors caught
 * during parsing, or empty array on success. */
export function applyStylesheetToGraph(graph: Graph): { errors: StylesheetParseError[] } {
  const src = graph.attrs.model_stylesheet ?? "";
  if (src.trim() === "") return { errors: [] };
  try {
    const rules = parseStylesheet(src);
    applyStylesheet(graph, rules);
    return { errors: [] };
  } catch (err) {
    if (err instanceof StylesheetParseError) return { errors: [err] };
    throw err;
  }
}

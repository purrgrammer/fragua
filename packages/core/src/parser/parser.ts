// Recursive-descent DOT parser producing a swarm Graph. Strict subset:
//   digraph name { stmt_list }
//   stmt := attr_stmt | graph_attr | node_stmt | edge_stmt | subgraph_stmt
//   attr_stmt := ("graph" | "node" | "edge") attr_list
//   graph_attr := IDENT "=" value
//   node_stmt := IDENT [attr_list]
//   edge_stmt := node_id ("->" node_id)+ [attr_list]    // directed only
//   subgraph_stmt := "subgraph" [IDENT] "{" stmt_list "}"
//   attr_list := "[" [a_list] "]" ("[" [a_list] "]")*
//
// Defaults (`node [...]`, `edge [...]`, `graph [...]`) apply to subsequent
// statements in the enclosing scope (subgraph-local).

import type { Edge, EdgeAttrs, Graph, GraphAttrs, Node, NodeAttrs, NodeShape, Subgraph } from "../types/graph.ts";
import { type Keyword, LexError, type Token, tokenize } from "./lexer.ts";

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`${message} at line ${line}, col ${col}`);
    this.name = "ParseError";
  }
}

type AttrPairs = Record<string, string | number | boolean>;

interface Scope {
  nodeDefaults: AttrPairs;
  edgeDefaults: AttrPairs;
  graphDefaults: AttrPairs;
  /** Subgraphs contribute class names to contained nodes. */
  subgraphClasses: string[];
}

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  parseTopLevel(): Graph {
    this.expectKeyword("digraph");
    const name = this.peekIs("IDENT") || this.peekIs("STRING") ? this.advance().value : "main";
    this.expect("LBRACE");

    const nodes: Record<string, Node> = {};
    const edges: Edge[] = [];
    const subgraphs: Subgraph[] = [];
    const graphAttrs: AttrPairs = {};

    const scope: Scope = {
      nodeDefaults: {},
      edgeDefaults: {},
      graphDefaults: {},
      subgraphClasses: [],
    };

    this.parseStmtList(nodes, edges, subgraphs, graphAttrs, scope);

    this.expect("RBRACE");
    this.expect("EOF");

    // Copy accumulated graph defaults into graphAttrs too — `graph [goal="..."]`
    // and plain `goal="..."` at graph scope are equivalent.
    for (const [k, v] of Object.entries(scope.graphDefaults)) {
      if (!(k in graphAttrs)) graphAttrs[k] = v;
    }

    return {
      id: name,
      directed: true,
      attrs: coerceAttrs<GraphAttrs>(graphAttrs),
      nodes,
      edges,
      subgraphs,
    };
  }

  private parseStmtList(
    nodes: Record<string, Node>,
    edges: Edge[],
    subgraphs: Subgraph[],
    graphAttrs: AttrPairs,
    scope: Scope,
  ): void {
    while (!this.peekIs("RBRACE") && !this.peekIs("EOF")) {
      this.parseStmt(nodes, edges, subgraphs, graphAttrs, scope);
      // Optional trailing semicolon or comma
      if (this.peekIs("SEMI")) this.advance();
    }
  }

  private parseStmt(
    nodes: Record<string, Node>,
    edges: Edge[],
    subgraphs: Subgraph[],
    graphAttrs: AttrPairs,
    scope: Scope,
  ): void {
    // Keyword-led statements first
    if (this.peekIs("KEYWORD")) {
      const kw = this.peek().value as Keyword;
      if (kw === "graph" || kw === "node" || kw === "edge") {
        this.advance();
        const attrs = this.parseAttrList();
        if (kw === "graph") Object.assign(scope.graphDefaults, attrs);
        else if (kw === "node") Object.assign(scope.nodeDefaults, attrs);
        else Object.assign(scope.edgeDefaults, attrs);
        return;
      }
      if (kw === "subgraph") {
        this.advance();
        this.parseSubgraph(nodes, edges, subgraphs, graphAttrs, scope);
        return;
      }
      if (kw === "strict") {
        throw new ParseError("`strict` graphs are not supported by swarm", this.peek().line, this.peek().col);
      }
      throw new ParseError(`unexpected keyword "${kw}"`, this.peek().line, this.peek().col);
    }

    // Subgraph without keyword (just `{ ... }`) is uncommon; we require the keyword.

    // Identifier — could be:
    //  - graph attr: IDENT "=" value
    //  - node stmt or edge stmt
    if (this.peekIs("IDENT") || this.peekIs("STRING") || this.peekIs("NUMBER")) {
      // look ahead for "=" (graph attr) vs "->" (edge) vs anything else (node)
      const idTok = this.advance();
      if (this.peekIs("EQUALS")) {
        this.advance();
        const v = this.parseValue();
        graphAttrs[idTok.value] = v;
        return;
      }
      // Node or edge: starting id already consumed.
      this.parseNodeOrEdgeStmt(idTok, nodes, edges, scope);
      return;
    }

    throw new ParseError(`unexpected token "${this.peek().value}"`, this.peek().line, this.peek().col);
  }

  private parseNodeOrEdgeStmt(firstId: Token, nodes: Record<string, Node>, edges: Edge[], scope: Scope): void {
    const chain: Token[] = [firstId];
    while (this.peekIs("ARROW")) {
      this.advance();
      if (!(this.peekIs("IDENT") || this.peekIs("STRING"))) {
        throw new ParseError("expected node id after `->`", this.peek().line, this.peek().col);
      }
      chain.push(this.advance());
    }

    const attrs = this.peekIs("LBRACKET") ? this.parseAttrList() : {};

    if (chain.length === 1) {
      // Node statement
      ensureNode(nodes, chain[0]!, scope, attrs);
      return;
    }

    // Edge chain: A -> B -> C becomes two edges with the same attr block.
    // Also ensure each endpoint exists as a node (using only scope defaults).
    for (const tok of chain) ensureNode(nodes, tok, scope, {});
    const edgeAttrs = { ...scope.edgeDefaults, ...attrs };
    for (let k = 0; k < chain.length - 1; k++) {
      const from = chain[k]!;
      const to = chain[k + 1]!;
      edges.push({
        from: from.value,
        to: to.value,
        attrs: coerceAttrs<EdgeAttrs>(edgeAttrs),
        loc: { line: from.line, col: from.col },
      });
    }
  }

  private parseSubgraph(
    nodes: Record<string, Node>,
    edges: Edge[],
    subgraphs: Subgraph[],
    graphAttrs: AttrPairs,
    parentScope: Scope,
  ): void {
    const nameTok = this.peekIs("IDENT") || this.peekIs("STRING") ? this.advance() : null;
    this.expect("LBRACE");

    const subId = nameTok?.value ?? `__anon_${subgraphs.length}`;
    const beforeNodeIds = new Set(Object.keys(nodes));

    const childScope: Scope = {
      nodeDefaults: { ...parentScope.nodeDefaults },
      edgeDefaults: { ...parentScope.edgeDefaults },
      graphDefaults: { ...parentScope.graphDefaults },
      subgraphClasses: [...parentScope.subgraphClasses],
    };

    // The subgraph id (if it starts with `cluster_`, the label after the
    // underscore becomes the derived class). Otherwise use the id as class.
    const derivedClass = deriveClass(subId, childScope.graphDefaults["label"] as string | undefined);
    if (derivedClass) childScope.subgraphClasses.push(derivedClass);

    this.parseStmtList(nodes, edges, subgraphs, graphAttrs, childScope);
    this.expect("RBRACE");

    const afterNodeIds = Object.keys(nodes);
    const ownNodeIds = afterNodeIds.filter((id) => !beforeNodeIds.has(id));

    // Apply subgraph class to newly-created nodes (already handled at creation
    // via scope.subgraphClasses, but we re-sync here in case ensureNode was
    // called before the class list was finalized).
    if (derivedClass) {
      for (const id of ownNodeIds) {
        const n = nodes[id]!;
        if (!n.classes.includes(derivedClass)) n.classes.push(derivedClass);
      }
    }

    const sgLabel = childScope.graphDefaults["label"];
    const sub: Subgraph = {
      id: subId,
      node_ids: ownNodeIds,
      node_defaults: coerceAttrs<NodeAttrs>(childScope.nodeDefaults),
    };
    if (typeof sgLabel === "string") sub.label = sgLabel;
    if (derivedClass) sub.derived_class = derivedClass;
    subgraphs.push(sub);
  }

  private parseAttrList(): AttrPairs {
    const out: AttrPairs = {};
    while (this.peekIs("LBRACKET")) {
      this.advance();
      while (!this.peekIs("RBRACKET")) {
        if (!(this.peekIs("IDENT") || this.peekIs("STRING"))) {
          throw new ParseError("expected attribute key", this.peek().line, this.peek().col);
        }
        const key = this.advance().value;
        this.expect("EQUALS");
        const v = this.parseValue();
        out[key] = v;
        if (this.peekIs("COMMA") || this.peekIs("SEMI")) this.advance();
      }
      this.expect("RBRACKET");
    }
    return out;
  }

  private parseValue(): string | number | boolean {
    const t = this.advance();
    if (t.type === "STRING") return t.value;
    if (t.type === "NUMBER") return Number.parseFloat(t.value);
    if (t.type === "IDENT") {
      if (t.value === "true") return true;
      if (t.value === "false") return false;
      return t.value;
    }
    throw new ParseError(`expected value, got "${t.value}"`, t.line, t.col);
  }

  // ---- token helpers -----------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[this.i + offset]!;
  }

  private peekIs(type: Token["type"]): boolean {
    return this.peek().type === type;
  }

  private advance(): Token {
    return this.tokens[this.i++]!;
  }

  private expect(type: Token["type"]): Token {
    const t = this.peek();
    if (t.type !== type) throw new ParseError(`expected ${type}, got ${t.type} "${t.value}"`, t.line, t.col);
    return this.advance();
  }

  private expectKeyword(kw: Keyword): Token {
    const t = this.peek();
    if (t.type !== "KEYWORD" || t.value !== kw)
      throw new ParseError(`expected keyword "${kw}", got ${t.type} "${t.value}"`, t.line, t.col);
    return this.advance();
  }
}

function ensureNode(nodes: Record<string, Node>, idTok: Token, scope: Scope, attrs: AttrPairs): Node {
  const id = idTok.value;
  const existing = nodes[id];
  if (existing) {
    // Merge new attrs on top of existing (last-write-wins per DOT convention).
    const merged: AttrPairs = { ...toAttrPairs(existing.attrs), ...attrs };
    const shape = resolveShape(merged, scope);
    existing.shape = shape;
    existing.attrs = coerceAttrs<NodeAttrs>({ ...scope.nodeDefaults, ...merged });
    // Merge class list
    for (const c of scope.subgraphClasses) if (!existing.classes.includes(c)) existing.classes.push(c);
    const classStr = merged["class"];
    if (typeof classStr === "string") {
      for (const c of classStr
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        if (!existing.classes.includes(c)) existing.classes.push(c);
      }
    }
    return existing;
  }

  const merged: AttrPairs = { ...scope.nodeDefaults, ...attrs };
  const shape = resolveShape(merged, scope);
  const classes: string[] = [...scope.subgraphClasses];
  const classStr = merged["class"];
  if (typeof classStr === "string") {
    for (const c of classStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (!classes.includes(c)) classes.push(c);
    }
  }

  const node: Node = {
    id,
    shape,
    attrs: coerceAttrs<NodeAttrs>(merged),
    classes,
    loc: { line: idTok.line, col: idTok.col },
  };
  nodes[id] = node;
  return node;
}

function resolveShape(attrs: AttrPairs, scope: Scope): NodeShape {
  const explicit = attrs["shape"] ?? scope.nodeDefaults["shape"];
  if (typeof explicit === "string" && isNodeShape(explicit)) return explicit;
  return "box";
}

function isNodeShape(s: string): s is NodeShape {
  return (
    s === "Mdiamond" ||
    s === "Msquare" ||
    s === "box" ||
    s === "diamond" ||
    s === "hexagon" ||
    s === "component" ||
    s === "tripleoctagon" ||
    s === "parallelogram"
  );
}

function deriveClass(subgraphId: string, label: string | undefined): string | undefined {
  // DOT convention: cluster_<name> clusters are clusters; label takes precedence for class naming.
  const candidate = label ?? subgraphId.replace(/^cluster_/, "");
  if (!candidate) return undefined;
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toAttrPairs(attrs: Record<string, unknown>): AttrPairs {
  const out: AttrPairs = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = String(v);
  }
  return out;
}

// ---- attribute coercion -----------------------------------------------

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "goal_gate",
  "auto_status",
  "allow_partial",
  "skills_disabled",
  "retry_jitter",
  // loop_restart edge attribute — typed for parser correctness so the
  // UI (GraphView) can read `e.attrs["loop_restart"] === true` directly.
  // Engine behavior is still a deliberate non-feature (docs/SPEC.md §6.5);
  // setting it true does not actually re-launch the run.
  "loop_restart",
]);

const INT_KEYS: ReadonlySet<string> = new Set([
  "max_retries",
  "default_max_retries",
  "idle_timeout",
  "max_goal_gate_retries",
  "retry_initial_delay_ms",
  "retry_max_delay_ms",
]);

const NUMBER_KEYS: ReadonlySet<string> = new Set([
  "weight",
  // Budget knobs (graph + node). Declared as numbers so DOT authors can
  // write `budget_usd = 0.75` without quoting and the runtime gets a real
  // number, not "0.75".
  "max_cost_usd",
  "max_tokens",
  "budget_usd",
  "budget_tokens",
  // Retry-policy backoff override (attractor §3.6 — float multiplier).
  "retry_backoff_factor",
]);

const STRING_ARRAY_KEYS: ReadonlySet<string> = new Set(["allowed_tools", "denied_tools", "context_files", "skills"]);

/**
 * Keys whose value must be one of a closed set of strings. Anything else
 * fails parsing — workflows fail at `POST /workflows` rather than mid-run.
 */
const ENUM_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([["budget_policy", new Set(["warn", "stop"])]]);

function coerceScalar(key: string, raw: string | number | boolean): string | number | boolean | string[] | undefined {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === 1) return true;
    if (raw === "false" || raw === 0) return false;
    return Boolean(raw);
  }
  if (INT_KEYS.has(key)) {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  if (NUMBER_KEYS.has(key)) {
    const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    return Number.isFinite(n) ? n : undefined;
  }
  if (STRING_ARRAY_KEYS.has(key)) {
    if (typeof raw === "string")
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return undefined;
  }
  const allowed = ENUM_KEYS.get(key);
  if (allowed !== undefined) {
    const s = typeof raw === "string" ? raw : String(raw);
    if (!allowed.has(s)) {
      throw new ParseError(
        `invalid value for ${key}: ${JSON.stringify(s)} (expected one of ${[...allowed].map((v) => JSON.stringify(v)).join(", ")})`,
        0,
        0,
      );
    }
    return s;
  }
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : String(raw);
}

function coerceAttrs<T extends NodeAttrs | EdgeAttrs | GraphAttrs>(pairs: AttrPairs): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pairs)) {
    const coerced = coerceScalar(k, v);
    if (coerced !== undefined) out[k] = coerced;
  }
  return out as T;
}

export function parseDotSource(source: string): Graph {
  let tokens: Token[];
  try {
    tokens = tokenize(source);
  } catch (err) {
    if (err instanceof LexError) throw new ParseError(err.message, err.line, err.col);
    throw err;
  }
  const p = new Parser(tokens);
  return p.parseTopLevel();
}

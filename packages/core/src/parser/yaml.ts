// YAML workflow parser. Lowers an authoring-time YAML document to the
// canonical in-memory `Graph` shape (`../types/graph.ts`).
//
// Authoring shape (high level):
//
//   name: my-workflow              # required — Graph.id
//   goal: |                        # optional — graph-level attrs
//     Prose intent for the workflow.
//   label: my-workflow             # optional
//   budget_usd: 5.0
//   budget_policy: pause
//
//   nodes:
//     start:
//       type: start                # discriminator: start | exit | llm | human | tool
//     do_work:
//       type: llm
//       prompt: |
//         Block-scalar prompts read cleanly, no quote-escaping.
//       thread_id: dev
//       summary: medium            # opt-in summariser (validator E027 if thread_id absent)
//       allowed_tools: [read, bash]
//     done:
//       type: exit
//
//   edges:
//     - {from: start, to: do_work}
//     - {from: do_work, to: done, outcome: success}
//     - {from: do_work, to: done, outcome: fail}
//
// Phase 1 mapping to the in-memory Graph:
//
//   YAML `type:`           Graph Node.shape
//   ─────────────────────  ────────────────
//   start                  Mdiamond
//   exit                   Msquare
//   llm                    box
//   human                  hexagon
//   tool                   parallelogram
//
// The shape field stays in the in-memory IR so the engine code that
// already reads it doesn't change. Phase 2 collapses shape into `type`
// outright; Phase 1 keeps both for minimum-blast-radius migration.

import * as YAML from "yaml";
import type { Edge, EdgeAttrs, Graph, GraphAttrs, Node, NodeAttrs, NodeShape } from "../types/graph.ts";

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = "ParseError";
  }
}

/** Map authoring-time `type:` discriminator to the in-memory `Node.shape`.
 * Phase 1 keeps the shape field because the engine + validator read it
 * directly; Phase 2 will collapse the IR to a `type`-only model. */
const TYPE_TO_SHAPE: Readonly<Record<string, NodeShape>> = {
  start: "Mdiamond",
  exit: "Msquare",
  llm: "box",
  human: "hexagon",
  tool: "parallelogram",
};

const KNOWN_TYPES = Object.keys(TYPE_TO_SHAPE);

// ---- attribute coercion (lifted from the DOT parser; same rules) ------

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  "goal_gate",
  "auto_status",
  "allow_partial",
  "skills_disabled",
  "retry_jitter",
  "loop_restart",
]);

const INT_KEYS: ReadonlySet<string> = new Set([
  "max_retries",
  "default_max_retries",
  "idle_timeout",
  "max_goal_gate_retries",
  "max_ms",
  "retry_initial_delay_ms",
  "retry_max_delay_ms",
]);

const NUMBER_KEYS: ReadonlySet<string> = new Set([
  "max_cost_usd",
  "max_tokens",
  "budget_usd",
  "budget_tokens",
  "retry_backoff_factor",
]);

const STRING_ARRAY_KEYS: ReadonlySet<string> = new Set([
  "allowed_tools",
  "denied_tools",
  "context_files",
  "skills",
  "routes",
]);

const ENUM_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["budget_policy", new Set(["warn", "stop", "pause"])],
  ["outcome", new Set(["success", "fail"])],
  ["kind", new Set(["codergen", "tool", "human"])],
  ["summary", new Set(["low", "medium", "high"])],
]);

/** Coerce a YAML-parsed scalar to the typed shape the IR expects. YAML
 * already gives us booleans, numbers, and arrays natively, so this is
 * mostly a sanity-check + enum-validation layer rather than a coercion
 * one. */
function coerceScalar(
  key: string,
  raw: unknown,
  loc: { line: number; col: number },
): string | number | boolean | string[] | undefined {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === 0 || raw === 1) return raw === 1;
    return undefined;
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
    if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
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
        loc.line,
        loc.col,
      );
    }
    return s;
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  return undefined;
}

interface AttrSource {
  pairs: Iterable<[string, unknown]>;
  locOf(key: string): { line: number; col: number };
}

function coerceAttrs<T extends NodeAttrs | EdgeAttrs | GraphAttrs>(src: AttrSource): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of src.pairs) {
    const coerced = coerceScalar(k, v, src.locOf(k));
    if (coerced !== undefined) out[k] = coerced;
  }
  return out as T;
}

// ---- YAML document walker ---------------------------------------------

interface YamlDocLike {
  errors: ReadonlyArray<{ message: string; pos?: readonly [number, number] }>;
  contents: unknown;
}

function locOf(node: unknown, lineCounter: YAML.LineCounter): { line: number; col: number } {
  if (node && typeof node === "object" && "range" in node && Array.isArray((node as { range?: unknown }).range)) {
    const range = (node as { range: readonly number[] }).range;
    const offset = range[0];
    if (typeof offset === "number") {
      const pos = lineCounter.linePos(offset);
      return { line: pos.line, col: pos.col };
    }
  }
  return { line: 0, col: 0 };
}

/** Top-level entry point. Parses a YAML workflow source and returns the
 * in-memory Graph the engine consumes. Throws `ParseError` on syntactic
 * errors with line/col anchors. */
export function parseWorkflow(source: string): Graph {
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(source, { lineCounter, prettyErrors: true });
  for (const err of doc.errors) {
    const offset = err.pos?.[0];
    const pos = typeof offset === "number" ? lineCounter.linePos(offset) : { line: 0, col: 0 };
    throw new ParseError(`YAML parse error: ${err.message}`, pos.line, pos.col);
  }
  const root = doc.contents;
  if (!YAML.isMap(root)) {
    throw new ParseError("workflow root must be a mapping", 1, 1);
  }

  const idNode = root.get("name", true) as YAML.Scalar | undefined;
  const id = idNode ? String(idNode.value ?? "").trim() : "";
  if (!id) {
    throw new ParseError("workflow missing required `name:` field", 1, 1);
  }

  const nodesNode = root.get("nodes", true);
  const edgesNode = root.get("edges", true);
  if (!YAML.isMap(nodesNode)) {
    throw new ParseError("workflow missing `nodes:` mapping", 1, 1);
  }
  if (!YAML.isSeq(edgesNode)) {
    throw new ParseError("workflow missing `edges:` sequence", 1, 1);
  }

  // Graph-level attrs: every top-level key OTHER than name / nodes / edges
  // is treated as a GraphAttr. Matches the DOT convention of putting these
  // under `graph [ ... ]` — flat at the top level in YAML reads more
  // naturally.
  const RESERVED = new Set(["name", "nodes", "edges"]);
  const graphPairs: Array<[string, unknown]> = [];
  const graphAttrLocs = new Map<string, { line: number; col: number }>();
  for (const item of root.items) {
    const k = (item.key as YAML.Scalar)?.value;
    if (typeof k !== "string" || RESERVED.has(k)) continue;
    const v = YAML.isScalar(item.value)
      ? item.value.value
      : ((item.value as unknown as YAML.Node)?.toJSON?.() ?? item.value);
    graphPairs.push([k, v]);
    graphAttrLocs.set(k, locOf(item.value, lineCounter));
  }
  const graphAttrs = coerceAttrs<GraphAttrs>({
    pairs: graphPairs,
    locOf: (k) => graphAttrLocs.get(k) ?? { line: 0, col: 0 },
  });

  const nodes: Record<string, Node> = {};
  for (const item of nodesNode.items) {
    const nodeId = (item.key as YAML.Scalar)?.value;
    if (typeof nodeId !== "string") {
      throw new ParseError("node id must be a string", ...locArr(locOf(item.key, lineCounter)));
    }
    const body = item.value;
    if (!YAML.isMap(body)) {
      throw new ParseError(`node "${nodeId}" must be a mapping`, ...locArr(locOf(item.value, lineCounter)));
    }
    const typeNode = body.get("type", true) as YAML.Scalar | undefined;
    const typeStr = typeNode ? String(typeNode.value ?? "") : "";
    if (!KNOWN_TYPES.includes(typeStr)) {
      throw new ParseError(
        `node "${nodeId}" has unknown type ${JSON.stringify(typeStr)} (expected one of ${KNOWN_TYPES.join(", ")})`,
        ...locArr(locOf(typeNode ?? body, lineCounter)),
      );
    }
    const shape = TYPE_TO_SHAPE[typeStr] as NodeShape;

    const nodePairs: Array<[string, unknown]> = [];
    const nodeAttrLocs = new Map<string, { line: number; col: number }>();
    for (const sub of body.items) {
      const k = (sub.key as YAML.Scalar)?.value;
      if (typeof k !== "string" || k === "type") continue;
      const v = YAML.isScalar(sub.value)
        ? sub.value.value
        : YAML.isSeq(sub.value) || YAML.isMap(sub.value)
          ? (sub.value as unknown as YAML.Node).toJSON()
          : sub.value;
      nodePairs.push([k, v]);
      nodeAttrLocs.set(k, locOf(sub.value, lineCounter));
    }
    const attrs = coerceAttrs<NodeAttrs>({
      pairs: nodePairs,
      locOf: (k) => nodeAttrLocs.get(k) ?? { line: 0, col: 0 },
    });
    attrs.shape = shape;
    // Lower the YAML discriminator to the engine's pre-cutover kind
    // vocabulary (`codergen` / `human` / `tool`). The author writes
    // `type: llm` but internally we still call it `codergen` until
    // Phase 2 retires `kind` outright. Setting both `kind` and `type`
    // here means handlerOf() resolves correctly without depending on
    // SHAPE_TO_KIND back-derivation, and the validator's E025
    // shape/kind-contradiction check passes.
    if (typeStr === "llm") {
      attrs.kind = "codergen";
      attrs.type = "codergen";
    } else if (typeStr === "human" || typeStr === "tool") {
      attrs.kind = typeStr;
      attrs.type = typeStr;
    } else if (typeStr === "start" || typeStr === "exit") {
      attrs.type = typeStr;
    }

    nodes[nodeId] = {
      id: nodeId,
      shape,
      attrs,
      classes: typeof attrs.class === "string" && attrs.class.length > 0 ? attrs.class.split(/\s+/) : [],
      loc: locOf(item.key, lineCounter),
    };
  }

  const edges: Edge[] = [];
  for (const item of edgesNode.items) {
    if (!YAML.isMap(item)) {
      throw new ParseError("each edge must be a mapping with `from` and `to`", ...locArr(locOf(item, lineCounter)));
    }
    const from = (item.get("from", true) as YAML.Scalar | undefined)?.value;
    const to = (item.get("to", true) as YAML.Scalar | undefined)?.value;
    if (typeof from !== "string" || typeof to !== "string") {
      throw new ParseError("edge must have string `from` and `to` ids", ...locArr(locOf(item, lineCounter)));
    }
    const edgePairs: Array<[string, unknown]> = [];
    const edgeLocs = new Map<string, { line: number; col: number }>();
    for (const sub of item.items) {
      const k = (sub.key as YAML.Scalar)?.value;
      if (typeof k !== "string" || k === "from" || k === "to") continue;
      const v = YAML.isScalar(sub.value)
        ? sub.value.value
        : YAML.isSeq(sub.value) || YAML.isMap(sub.value)
          ? (sub.value as unknown as YAML.Node).toJSON()
          : sub.value;
      edgePairs.push([k, v]);
      edgeLocs.set(k, locOf(sub.value, lineCounter));
    }
    const attrs = coerceAttrs<EdgeAttrs>({
      pairs: edgePairs,
      locOf: (k) => edgeLocs.get(k) ?? { line: 0, col: 0 },
    });
    edges.push({ from, to, attrs, loc: locOf(item, lineCounter) });
  }

  return {
    id,
    directed: true,
    attrs: graphAttrs,
    nodes,
    edges,
    subgraphs: [],
  };
}

function locArr(loc: { line: number; col: number }): [number, number] {
  return [loc.line, loc.col];
}

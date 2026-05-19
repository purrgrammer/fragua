// YAML workflow parser — GHA-style authoring shape.
//
//   name: my-workflow
//   description: |
//     Optional prose explaining what this workflow does.
//   goal: One-sentence goal.
//
//   inputs:
//     ticket:
//       type: string
//       required: true
//       description: Bug ticket id
//     dry-run:
//       type: boolean
//       default: false
//     env:
//       type: choice
//       options: [dev, staging, prod]
//
//   budget: 5.00
//   budget-policy: pause
//   thread: dev
//
//   defaults:
//     model: claude-sonnet-4-6
//     provider: anthropic
//
//   steps:
//     plan:
//       type: llm
//       prompt: |
//         Plan ticket ${{ inputs.ticket }}.
//       # implicit next: implement (next declared step)
//
//     implement:
//       type: llm
//       prompt: |
//         Implement.
//
//     review:
//       type: llm
//       prompt: |
//         Review.
//       retry: implement
//       max-retries: 3
//
//     ci:
//       type: tool
//       run: bun run ci
//       max-retries: 5
//       on: {success: commit, fail: fix}
//
//     fix:
//       type: llm
//       prompt: |
//         Fix CI.
//       next: ci
//
//     commit:
//       type: llm
//       prompt: |
//         Commit.
//
// Authoring rules:
//   - Linear by default: a step with no `next:`/`on:`/`routes:` flows to the
//     next declared step (last step flows to `exit`).
//   - `next: X` ≡ `on: {success: X}`. Both forms also synthesize an implicit
//     `fail → exit` edge so unhandled fails terminate the run gracefully.
//   - `routes:` is for human nodes and llm nodes that use the `route` tool.
//     Compact form `{a: X, b: Y}`; expanded form `{a: {to: X, label: "..."}}`.
//   - `type: exit` is a reserved sink. Authors target it via `next: exit`,
//     `on: {fail: exit}`, or `routes: {x: exit}` — no explicit step needed.
//   - First declared step IS the entry point. Parser synthesizes a hidden
//     `__start__` node that the engine treats as the run's first transition.
//   - Template substitution: `${{ inputs.name }}` substitutes in `prompt:`,
//     `text:`, `run:` strings. Validator E029 catches references to
//     undeclared inputs.
//
// Mapping from authoring kebab-case to IR snake_case lives in
// AUTHORING_KEY_TO_IR and is centralised so the validator + tests can
// reuse the same name table.

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

// ---- Type → shape lowering --------------------------------------------

const TYPE_TO_SHAPE: Readonly<Record<string, NodeShape>> = {
  llm: "box",
  human: "hexagon",
  tool: "parallelogram",
  exit: "Msquare",
};

const KNOWN_TYPES = new Set(Object.keys(TYPE_TO_SHAPE));

// ---- Authoring-key → IR-key rename table ------------------------------
//
// Authors write kebab-case (GHA-aligned); the IR keeps snake_case so the
// rest of the codebase (engine, validator, agent backend) doesn't churn.
// One-way lowering at parse time; nothing reads the kebab name after.

const STEP_KEY_TO_IR: Readonly<Record<string, string>> = {
  // identity (already canonical)
  prompt: "prompt",
  text: "text",
  type: "type",
  summary: "summary",
  skills: "skills",

  // kebab → snake
  thread: "thread_id",
  model: "llm_model",
  provider: "llm_provider",
  effort: "reasoning_effort",
  "allowed-tools": "allowed_tools",
  "denied-tools": "denied_tools",
  "max-cost": "max_cost_usd",
  "max-tokens": "max_tokens",
  "max-retries": "max_retries",
  run: "tool_command",
};

const GRAPH_KEY_TO_IR: Readonly<Record<string, string>> = {
  goal: "goal",
  description: "label",
  thread: "thread_id",
  budget: "budget_usd",
  "budget-policy": "budget_policy",
};

// Keys consumed by the parser at the step level (not stored in attrs):
const STEP_RESERVED = new Set(["type", "next", "on", "routes", "retry", "timeout-minutes"]);
// Keys consumed at the graph level (not stored in attrs):
const GRAPH_RESERVED = new Set(["name", "steps", "inputs", "defaults"]);

// ---- Attribute coercion -----------------------------------------------

const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["goal_gate"]);

const INT_KEYS: ReadonlySet<string> = new Set(["max_retries", "max_tokens", "max_ms"]);

const NUMBER_KEYS: ReadonlySet<string> = new Set(["max_cost_usd", "budget_usd"]);

const STRING_ARRAY_KEYS: ReadonlySet<string> = new Set(["allowed_tools", "denied_tools", "skills", "routes"]);

const ENUM_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["budget_policy", new Set(["warn", "stop", "pause"])],
  ["outcome", new Set(["success", "fail"])],
  ["kind", new Set(["codergen", "tool", "human"])],
  ["summary", new Set(["low", "medium", "high"])],
  ["reasoning_effort", new Set(["low", "medium", "high"])],
]);

function coerceScalar(
  key: string,
  raw: unknown,
  loc: { line: number; col: number },
): string | number | boolean | string[] | undefined {
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
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

// ---- YAML helpers -----------------------------------------------------

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

function locArr(loc: { line: number; col: number }): [number, number] {
  return [loc.line, loc.col];
}

function scalarValue(node: unknown): unknown {
  if (YAML.isScalar(node)) return node.value;
  if (YAML.isSeq(node) || YAML.isMap(node)) return (node as unknown as YAML.Node).toJSON?.() ?? node;
  return node;
}

// ---- Input declarations -----------------------------------------------

export interface InputDecl {
  name: string;
  type: "string" | "boolean" | "number" | "choice";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

function parseInputs(node: unknown, lineCounter: YAML.LineCounter): InputDecl[] {
  if (node === undefined) return [];
  if (!YAML.isMap(node)) {
    throw new ParseError("`inputs:` must be a mapping", ...locArr(locOf(node, lineCounter)));
  }
  const out: InputDecl[] = [];
  for (const item of node.items) {
    const name = (item.key as YAML.Scalar)?.value;
    if (typeof name !== "string" || name.length === 0) {
      throw new ParseError("input name must be a non-empty string", ...locArr(locOf(item.key, lineCounter)));
    }
    const body = item.value;
    if (!YAML.isMap(body)) {
      throw new ParseError(`input "${name}" must be a mapping`, ...locArr(locOf(item.value, lineCounter)));
    }
    const tRaw = scalarValue(body.get("type", true));
    const type = typeof tRaw === "string" ? tRaw : "string";
    if (!["string", "boolean", "number", "choice"].includes(type)) {
      throw new ParseError(
        `input "${name}" has unknown type ${JSON.stringify(type)} (expected string / boolean / number / choice)`,
        ...locArr(locOf(body.get("type", true) ?? body, lineCounter)),
      );
    }
    const decl: InputDecl = {
      name,
      type: type as InputDecl["type"],
      required: scalarValue(body.get("required", true)) === true,
    };
    const desc = scalarValue(body.get("description", true));
    if (typeof desc === "string" && desc.length > 0) decl.description = desc;
    const def = scalarValue(body.get("default", true));
    if (def !== undefined && def !== null) decl.default = def as string | number | boolean;
    const opts = scalarValue(body.get("options", true));
    if (Array.isArray(opts)) decl.options = opts.filter((v): v is string => typeof v === "string");
    if (decl.type === "choice" && (!decl.options || decl.options.length === 0)) {
      throw new ParseError(
        `input "${name}" has type=choice but no options[]`,
        ...locArr(locOf(body, lineCounter)),
      );
    }
    out.push(decl);
  }
  return out;
}

// ---- Defaults block ---------------------------------------------------

function parseDefaults(node: unknown, lineCounter: YAML.LineCounter): Record<string, unknown> {
  if (node === undefined) return {};
  if (!YAML.isMap(node)) {
    throw new ParseError("`defaults:` must be a mapping", ...locArr(locOf(node, lineCounter)));
  }
  const out: Record<string, unknown> = {};
  for (const item of node.items) {
    const k = (item.key as YAML.Scalar)?.value;
    if (typeof k !== "string") continue;
    const irKey = STEP_KEY_TO_IR[k] ?? k;
    out[irKey] = scalarValue(item.value);
  }
  return out;
}

// ---- Top-level parser -------------------------------------------------

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

  const stepsNode = root.get("steps", true);
  if (!YAML.isMap(stepsNode)) {
    throw new ParseError("workflow missing `steps:` mapping", 1, 1);
  }

  const inputs = parseInputs(root.get("inputs", true), lineCounter);
  const defaults = parseDefaults(root.get("defaults", true), lineCounter);

  // Graph-level attrs: anything top-level not in GRAPH_RESERVED.
  const graphAttrs: Record<string, unknown> = {};
  const graphAttrLocs = new Map<string, { line: number; col: number }>();
  for (const item of root.items) {
    const k = (item.key as YAML.Scalar)?.value;
    if (typeof k !== "string" || GRAPH_RESERVED.has(k)) continue;
    const irKey = GRAPH_KEY_TO_IR[k] ?? k;
    graphAttrLocs.set(irKey, locOf(item.value, lineCounter));
    const coerced = coerceScalar(irKey, scalarValue(item.value), graphAttrLocs.get(irKey) ?? { line: 0, col: 0 });
    if (coerced !== undefined) graphAttrs[irKey] = coerced;
  }
  if (inputs.length > 0) graphAttrs.inputs = inputs;

  // Walk steps in declaration order — order matters for implicit linear flow.
  const stepIds: string[] = [];
  const stepBodies = new Map<string, YAML.YAMLMap>();
  for (const item of stepsNode.items) {
    const stepId = (item.key as YAML.Scalar)?.value;
    if (typeof stepId !== "string") {
      throw new ParseError("step id must be a string", ...locArr(locOf(item.key, lineCounter)));
    }
    if (!YAML.isMap(item.value)) {
      throw new ParseError(`step "${stepId}" must be a mapping`, ...locArr(locOf(item.value, lineCounter)));
    }
    stepIds.push(stepId);
    stepBodies.set(stepId, item.value);
  }
  if (stepIds.length === 0) {
    throw new ParseError("workflow has no steps", 1, 1);
  }

  const nodes: Record<string, Node> = {};
  const edges: Edge[] = [];

  // Synthesise the entry-point start node and an edge to the first step.
  // The engine looks for `routing.start_node` defaulting to "start" — so
  // we name the synthetic node "start" (not __start__) for that to match.
  // Authors don't declare it; validator E029 reserves the name.
  nodes.start = {
    id: "start",
    shape: "Mdiamond",
    attrs: { shape: "Mdiamond", type: "start", label: "start" } as NodeAttrs,
    classes: [],
  };
  edges.push({ from: "start", to: stepIds[0]!, attrs: {} });

  // Track which user-defined step ids exist so `next: exit` is recognised
  // as the reserved sink and synthesised on demand.
  const userStepIds = new Set(stepIds);
  let needExit = false;

  for (let i = 0; i < stepIds.length; i++) {
    const stepId = stepIds[i]!;
    const body = stepBodies.get(stepId)!;

    // ---- type discrimination ----
    const typeRaw = scalarValue(body.get("type", true));
    const typeStr = typeof typeRaw === "string" ? typeRaw : "llm"; // implicit llm
    if (!KNOWN_TYPES.has(typeStr)) {
      throw new ParseError(
        `step "${stepId}" has unknown type ${JSON.stringify(typeStr)} (expected one of llm / human / tool / exit)`,
        ...locArr(locOf(body.get("type", true) ?? body, lineCounter)),
      );
    }
    const shape = TYPE_TO_SHAPE[typeStr] as NodeShape;

    // ---- attribute walk ----
    const attrs: Record<string, unknown> = {};
    for (const sub of body.items) {
      const k = (sub.key as YAML.Scalar)?.value;
      if (typeof k !== "string") continue;
      if (STEP_RESERVED.has(k)) continue;
      const irKey = STEP_KEY_TO_IR[k] ?? k;
      const loc = locOf(sub.value, lineCounter);
      const coerced = coerceScalar(irKey, scalarValue(sub.value), loc);
      if (coerced !== undefined) attrs[irKey] = coerced;
    }
    // Apply `defaults:` for llm steps where the attr is absent.
    if (typeStr === "llm") {
      for (const [k, v] of Object.entries(defaults)) {
        if (attrs[k] === undefined) attrs[k] = v;
      }
    }
    // `timeout-minutes` → max_ms.
    const tm = scalarValue(body.get("timeout-minutes", true));
    if (typeof tm === "number" && Number.isFinite(tm)) {
      attrs.max_ms = Math.trunc(tm * 60_000);
    }
    // `retry: <step>` → goal_gate=true + retry_target=<step>.
    const retryTo = scalarValue(body.get("retry", true));
    if (typeof retryTo === "string" && retryTo.length > 0) {
      attrs.goal_gate = true;
      attrs.retry_target = retryTo;
    }
    // Lower type to IR kind/type for engine consumers.
    attrs.shape = shape;
    if (typeStr === "llm") {
      attrs.kind = "codergen";
      attrs.type = "codergen";
    } else if (typeStr === "human" || typeStr === "tool") {
      attrs.kind = typeStr;
      attrs.type = typeStr;
    } else if (typeStr === "exit") {
      attrs.type = "exit";
    }

    // ---- edge synthesis ----
    const nextNode = scalarValue(body.get("next", true));
    const onNode = body.get("on", true);
    const routesNode = body.get("routes", true);

    // Mutex check.
    const directives = [nextNode !== undefined, onNode !== undefined, routesNode !== undefined].filter(Boolean).length;
    if (directives > 1) {
      throw new ParseError(
        `step "${stepId}" has more than one of \`next:\` / \`on:\` / \`routes:\` (choose one)`,
        ...locArr(locOf(body, lineCounter)),
      );
    }

    if (routesNode !== undefined) {
      if (!YAML.isMap(routesNode)) {
        throw new ParseError(`step "${stepId}" routes: must be a mapping`, ...locArr(locOf(routesNode, lineCounter)));
      }
      const routeNames: string[] = [];
      for (const r of routesNode.items) {
        const rName = (r.key as YAML.Scalar)?.value;
        if (typeof rName !== "string") continue;
        routeNames.push(rName);
        let to: string | undefined;
        let label: string | undefined;
        if (YAML.isMap(r.value)) {
          const toRaw = scalarValue(r.value.get("to", true));
          const labelRaw = scalarValue(r.value.get("label", true));
          if (typeof toRaw === "string") to = toRaw;
          if (typeof labelRaw === "string") label = labelRaw;
        } else {
          const v = scalarValue(r.value);
          if (typeof v === "string") to = v;
        }
        if (!to) {
          throw new ParseError(
            `route "${rName}" on step "${stepId}" must have a target (compact form: \`${rName}: <step>\` or expanded \`${rName}: {to: <step>}\`)`,
            ...locArr(locOf(r.value, lineCounter)),
          );
        }
        if (to === "exit") needExit = true;
        const edgeAttrs: Record<string, unknown> = { route: rName };
        if (label !== undefined) edgeAttrs.label = label;
        edges.push({ from: stepId, to, attrs: edgeAttrs as EdgeAttrs });
      }
      attrs.routes = routeNames;
    } else if (onNode !== undefined) {
      if (!YAML.isMap(onNode)) {
        throw new ParseError(`step "${stepId}" on: must be a mapping`, ...locArr(locOf(onNode, lineCounter)));
      }
      const successTo = scalarValue((onNode as YAML.YAMLMap).get("success", true));
      const failTo = scalarValue((onNode as YAML.YAMLMap).get("fail", true));
      if (typeof successTo === "string" && successTo.length > 0) {
        if (successTo === "exit") needExit = true;
        edges.push({ from: stepId, to: successTo, attrs: { outcome: "success" } });
      }
      if (typeof failTo === "string" && failTo.length > 0) {
        if (failTo === "exit") needExit = true;
        edges.push({ from: stepId, to: failTo, attrs: { outcome: "fail" } });
      } else {
        // Implicit fail → exit on outcome-based steps with explicit success route.
        needExit = true;
        edges.push({ from: stepId, to: "exit", attrs: { outcome: "fail" } });
      }
    } else if (typeStr !== "exit") {
      // No explicit routing → linear default: success to next declared step
      // (or exit if last), implicit fail to exit.
      const successTo = typeof nextNode === "string" && nextNode.length > 0 ? nextNode : (stepIds[i + 1] ?? "exit");
      if (successTo === "exit") needExit = true;
      edges.push({ from: stepId, to: successTo, attrs: { outcome: "success" } });
      needExit = true;
      edges.push({ from: stepId, to: "exit", attrs: { outcome: "fail" } });
    }

    // ---- materialise the node ----
    nodes[stepId] = {
      id: stepId,
      shape,
      attrs: attrs as NodeAttrs,
      classes: [],
      loc: locOf(stepBodies.get(stepId), lineCounter),
    };
  }

  // Synthesise the reserved exit sink iff anything routes to it.
  if (needExit && !nodes.exit) {
    nodes.exit = {
      id: "exit",
      shape: "Msquare",
      attrs: { shape: "Msquare", type: "exit", label: "exit" } as NodeAttrs,
      classes: [],
    };
  }

  return {
    id,
    directed: true,
    attrs: graphAttrs as GraphAttrs,
    nodes,
    edges,
    subgraphs: [],
  };
}

// ---- Template substitution -------------------------------------------

/** Replace `${{ inputs.foo }}` references in a string with the input values
 * from `bindings`. References that resolve to `undefined` are left in place
 * — the validator catches undeclared refs (E029) at validate-time. */
export function substituteInputs(source: string, bindings: Record<string, string | number | boolean>): string {
  return source.replace(/\$\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g, (whole, name) => {
    const v = bindings[name];
    return v === undefined ? whole : String(v);
  });
}

/** Extract every `${{ inputs.X }}` reference name from a string. Used by
 * the validator (E029) to flag undeclared inputs at validate-time. */
export function inputReferences(source: string): string[] {
  const out: string[] = [];
  const re = /\$\{\{\s*inputs\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\}\}/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    m = re.exec(source);
  }
  return out;
}

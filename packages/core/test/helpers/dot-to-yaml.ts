// DOT → new-shape YAML translator for daemon test fixtures.
//
// NOT a production parser. Daemon tests carry ~50 inline DOT workflow
// fixtures from the pre-cutover era; rather than hand-migrate each, the
// shim translates them on the fly to the modern GHA-style YAML the
// production parser consumes. The shim itself can be deleted once the
// last inline DOT fixture is rewritten.
//
// Subset handled:
//   - `digraph [name] { ... }` wrapper (name picked up as the workflow name)
//   - line / block comments
//   - `graph [k=v]` attr blocks (lower into top-level graph attrs)
//   - node decls: `id [shape=X, k=v]` with shape→type lowering
//   - edge decls: `a -> b [outcome=X|route=Y|label=Z]`
//   - chained edge decls: `a -> b -> c`
//
// Output shape (lowered):
//   name: <graph name or "t">
//   <flat graph attrs>
//   steps:
//     <user steps>  ← start/exit nodes are dropped (synthesised by the parser)
//   <inline next:/on:/routes: on each step derived from DOT edges>
//
// Start/exit nodes from DOT are skipped — the new parser synthesises them.
// Edges from the user steps are converted into per-step `next:` / `on:` /
// `routes:` directives the new parser accepts.

const DOT_TYPE_FROM_SHAPE: Readonly<Record<string, string>> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "llm",
  hexagon: "human",
  parallelogram: "tool",
};

// IR-snake → kebab authoring keys (reverse of the parser's lowering).
const SNAKE_TO_KEBAB: Readonly<Record<string, string>> = {
  llm_model: "model",
  llm_provider: "provider",
  thread_id: "thread",
  reasoning_effort: "effort",
  allowed_tools: "allowed-tools",
  denied_tools: "denied-tools",
  max_cost_usd: "max-cost",
  max_tokens: "max-tokens",
  max_retries: "max-retries",
  tool_command: "run",
  goal_gate: "goal_gate", // keep underscored — lowered specially via `retry:`
  retry_target: "retry_target", // same
  budget_usd: "budget",
  budget_policy: "budget-policy",
};

interface ParsedAttrs {
  pairs: Array<[string, string | number | boolean]>;
}

/** Pass-through legacy callers that handed both DOT and YAML through this
 * helper. New tests should use new-shape YAML directly via `rig({ yaml })`. */
export function lowerIfDot(source: string): string {
  return source.trimStart().startsWith("digraph") ? dotToYaml(source) : source;
}

/** Translate a DOT-subset workflow source to the new GHA-style YAML the
 * production parser consumes. */
export function dotToYaml(dot: string): string {
  // Strip comments.
  const stripped = dot.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

  const bodyMatch = stripped.match(/digraph\s*(?:([A-Za-z_][\w]*)\s*)?\{([\s\S]*)\}\s*$/);
  if (!bodyMatch) throw new Error("dotToYaml: input does not look like a DOT digraph");
  const graphName = (bodyMatch[1] ?? "t").trim();
  const body = bodyMatch[2] ?? "";

  // Tokenise statements by semicolons + newlines.
  const stmts = body
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const graphAttrs: ParsedAttrs = { pairs: [] };
  const nodes = new Map<string, ParsedAttrs>();
  const declOrder: string[] = [];
  const edges: Array<{ from: string; to: string; attrs: ParsedAttrs }> = [];

  for (const stmt of stmts) {
    if (stmt.startsWith("graph ")) {
      const attrs = parseAttrBlock(stmt.slice("graph".length).trim());
      graphAttrs.pairs.push(...attrs.pairs);
      continue;
    }
    if (stmt.includes("->")) {
      // edge — may be chained `a -> b -> c [attrs]`
      const attrMatch = stmt.match(/^([^\[]+?)\s*(\[[^\]]*\])?\s*$/);
      const chain = (attrMatch?.[1] ?? stmt).split("->").map((s) => s.trim());
      const attrs = attrMatch?.[2] ? parseAttrBlock(attrMatch[2]) : { pairs: [] };
      for (let i = 0; i < chain.length - 1; i++) {
        const from = chain[i]!;
        const to = chain[i + 1]!;
        if (!nodes.has(from)) {
          nodes.set(from, { pairs: [] });
          declOrder.push(from);
        }
        if (!nodes.has(to)) {
          nodes.set(to, { pairs: [] });
          declOrder.push(to);
        }
        edges.push({ from, to, attrs });
      }
      continue;
    }
    // node decl: `id [attrs]`
    const nodeMatch = stmt.match(/^([A-Za-z_][\w]*)\s*(\[[^\]]*\])?\s*$/);
    if (nodeMatch) {
      const id = nodeMatch[1]!;
      const attrs = nodeMatch[2] ? parseAttrBlock(nodeMatch[2]) : { pairs: [] };
      if (nodes.has(id)) {
        nodes.get(id)!.pairs.push(...attrs.pairs);
      } else {
        nodes.set(id, attrs);
        declOrder.push(id);
      }
    }
  }

  // Identify start/exit nodes via shape attr. They're dropped — the new
  // parser synthesises both.
  const startIds = new Set<string>();
  const exitIds = new Set<string>();
  for (const [id, attrs] of nodes) {
    const shape = scalarOf(attrs, "shape");
    if (shape === "Mdiamond") startIds.add(id);
    if (shape === "Msquare") exitIds.add(id);
  }

  // Build per-step outgoing edge map for routing synthesis.
  const outEdges = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from)!.push(e);
  }

  const userStepIds = declOrder.filter((id) => !startIds.has(id) && !exitIds.has(id));

  // Map exitIds to the reserved "exit" sink name in the new shape.
  const lowerTarget = (id: string): string => (exitIds.has(id) ? "exit" : id);

  // Emit the YAML.
  const lines: string[] = [];
  lines.push(`name: ${graphName}`);
  for (const [k, v] of graphAttrs.pairs) {
    const kebab = SNAKE_TO_KEBAB[k] ?? k;
    lines.push(`${kebab}: ${yamlValue(v)}`);
  }
  lines.push("steps:");

  for (const id of userStepIds) {
    const attrs = nodes.get(id)!;
    const shape = scalarOf(attrs, "shape");
    const type = shape ? DOT_TYPE_FROM_SHAPE[shape] : "llm";
    const explicitKind = scalarOf(attrs, "kind");
    const finalType = explicitKind === "human" ? "human" : explicitKind === "tool" ? "tool" : type;

    lines.push(`  ${id}:`);
    lines.push(`    type: ${finalType}`);
    // Emit body attrs (skip shape — implicit from type).
    for (const [k, v] of attrs.pairs) {
      if (k === "shape" || k === "type" || k === "kind") continue;
      const kebab = SNAKE_TO_KEBAB[k] ?? k;
      lines.push(`    ${kebab}: ${yamlValue(v)}`);
    }

    // Synthesise routing from outgoing edges.
    const out = outEdges.get(id) ?? [];
    if (out.length === 0) {
      continue;
    }

    const hasOutcome = out.some((e) => scalarOf(e.attrs, "outcome"));
    const hasRoute = out.some((e) => scalarOf(e.attrs, "route"));

    if (hasRoute) {
      lines.push(`    routes:`);
      for (const e of out) {
        const route = scalarOf(e.attrs, "route");
        const label = scalarOf(e.attrs, "label");
        if (!route) continue;
        const target = lowerTarget(e.to);
        if (label) {
          lines.push(`      ${route}: {to: ${target}, label: ${yamlValue(label)}}`);
        } else {
          lines.push(`      ${route}: ${target}`);
        }
      }
    } else if (hasOutcome) {
      const success = out.find((e) => scalarOf(e.attrs, "outcome") === "success" || !scalarOf(e.attrs, "outcome"));
      const fail = out.find((e) => scalarOf(e.attrs, "outcome") === "fail");
      lines.push(`    on:`);
      if (success) lines.push(`      success: ${lowerTarget(success.to)}`);
      if (fail) lines.push(`      fail: ${lowerTarget(fail.to)}`);
    } else {
      // Single unconditional edge → next:
      const target = lowerTarget(out[0]!.to);
      lines.push(`    next: ${target}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function scalarOf(attrs: ParsedAttrs, key: string): string | undefined {
  for (const [k, v] of attrs.pairs) {
    if (k === key) return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

function yamlValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (/^[\w./-]+$/.test(v) && !["true", "false", "null"].includes(v)) return v;
  return JSON.stringify(v);
}

function parseAttrBlock(raw: string): ParsedAttrs {
  const trimmed = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!trimmed) return { pairs: [] };
  const pairs: Array<[string, string | number | boolean]> = [];
  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && /[\s,]/.test(trimmed[i]!)) i++;
    const keyStart = i;
    while (i < trimmed.length && /[\w.-]/.test(trimmed[i]!)) i++;
    const key = trimmed.slice(keyStart, i);
    if (!key) break;
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    if (trimmed[i] !== "=") break;
    i++;
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
    let value: string | number | boolean;
    if (trimmed[i] === '"') {
      i++;
      const valStart = i;
      while (i < trimmed.length && trimmed[i] !== '"') {
        if (trimmed[i] === "\\") i++;
        i++;
      }
      value = trimmed.slice(valStart, i).replace(/\\n/g, "\n").replace(/\\"/g, '"');
      i++;
    } else {
      const valStart = i;
      while (i < trimmed.length && !/[\s,]/.test(trimmed[i]!)) i++;
      const raw2 = trimmed.slice(valStart, i);
      if (raw2 === "true") value = true;
      else if (raw2 === "false") value = false;
      else if (/^-?\d+(\.\d+)?$/.test(raw2)) value = Number(raw2);
      else value = raw2;
    }
    pairs.push([key, value]);
  }
  return { pairs };
}

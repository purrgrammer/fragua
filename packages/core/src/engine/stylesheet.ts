// Model stylesheet — CSS-like selectors for assigning model/provider per node.
// Applied during the transform phase (before validation + execution).
// See docs/SPEC.md §3.1 (model_stylesheet attr).
//
// Syntax:
//   #nodeId       { model: claude-opus-4-7; provider: anthropic }
//   .heavy        { model: claude-opus-4-7; reasoning_effort: high }
//   [shape=box]   { model: claude-haiku-4-5 }
//   [class=fast]  { model: claude-haiku-4-5 }
//
// Node-level `model`/`provider`/`reasoning_effort` attrs always win.
// When multiple rules match, later rules override earlier ones (CSS-like).

import type { Graph, Node } from "../types/graph.ts";

type ReasoningEffort = "low" | "medium" | "high";

interface StyleDeclaration {
  model?: string;
  provider?: string;
  reasoning_effort?: ReasoningEffort;
}

type StyleSelector =
  | { kind: "id"; id: string }
  | { kind: "class"; cls: string }
  | { kind: "attr"; key: string; value: string };

interface StyleRule {
  selector: StyleSelector;
  decl: StyleDeclaration;
}

const BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g;
const ATTR_SELECTOR_RE = /^\[([A-Za-z_][\w.]*)=([^\]]+)\]$/;

export function parseStylesheet(source: string): StyleRule[] {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: StyleRule[] = [];
  let match: RegExpExecArray | null = BLOCK_RE.exec(cleaned);
  while (match !== null) {
    const selector = parseSelector(match[1]!);
    const decl = parseDeclarations(match[2]!);
    if (selector && hasAnyDecl(decl)) out.push({ selector, decl });
    match = BLOCK_RE.exec(cleaned);
  }
  BLOCK_RE.lastIndex = 0;
  return out;
}

function parseSelector(raw: string): StyleSelector | undefined {
  const t = raw.trim();
  if (t.startsWith("#")) return { kind: "id", id: t.slice(1).trim() };
  if (t.startsWith(".")) return { kind: "class", cls: t.slice(1).trim() };
  const attr = ATTR_SELECTOR_RE.exec(t);
  if (attr) return { kind: "attr", key: attr[1]!, value: attr[2]!.trim() };
  return undefined;
}

function parseDeclarations(raw: string): StyleDeclaration {
  const out: StyleDeclaration = {};
  for (const pair of raw.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!value) continue;
    if (key === "model") out.model = value;
    else if (key === "provider") out.provider = value;
    else if (key === "reasoning_effort" && (value === "low" || value === "medium" || value === "high")) {
      out.reasoning_effort = value;
    }
  }
  return out;
}

function hasAnyDecl(d: StyleDeclaration): boolean {
  return d.model !== undefined || d.provider !== undefined || d.reasoning_effort !== undefined;
}

function matches(node: Node, selector: StyleSelector): boolean {
  switch (selector.kind) {
    case "id":
      return node.id === selector.id;
    case "class":
      return node.classes.includes(selector.cls);
    case "attr": {
      if (selector.key === "shape") return node.shape === selector.value;
      const v = node.attrs[selector.key];
      return v !== undefined && String(v) === selector.value;
    }
  }
}

/** Mutate `graph.nodes` in place: fill in missing model/provider/reasoning_effort
 * from the graph-level stylesheet. Node-level attrs always win. */
export function applyStylesheet(graph: Graph): void {
  const source = graph.attrs.model_stylesheet;
  if (typeof source !== "string" || source.trim() === "") return;
  const rules = parseStylesheet(source);
  if (rules.length === 0) return;

  for (const node of Object.values(graph.nodes)) {
    const hadModel = node.attrs.model !== undefined;
    const hadProvider = node.attrs.provider !== undefined;
    const hadEffort = node.attrs.reasoning_effort !== undefined;
    for (const rule of rules) {
      if (!matches(node, rule.selector)) continue;
      if (!hadModel && rule.decl.model !== undefined) node.attrs.model = rule.decl.model;
      if (!hadProvider && rule.decl.provider !== undefined) node.attrs.provider = rule.decl.provider;
      if (!hadEffort && rule.decl.reasoning_effort !== undefined) {
        node.attrs.reasoning_effort = rule.decl.reasoning_effort;
      }
    }
  }
}

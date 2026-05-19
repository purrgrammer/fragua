// Tiny DOT → YAML converter for unblocking test files that carry
// hundreds of inline DOT fixtures from the pre-cutover era. NOT a
// production parser — exists only so engine/runtime tests can keep
// their existing DOT-shaped fixtures while the production parser
// consumes YAML. New tests should author YAML directly or use
// `mkGraph()` for engine tests.
//
// Subset handled:
//   - `digraph [name] { ... }` wrapper (name ignored; YAML name from caller)
//   - statements separated by newlines or `;`
//   - line comments `//` and block comments `/* … */`
//   - graph attr blocks: `graph [k=v, k=v]`
//   - node decls: `id [k=v, k="..."]` (single-line). attrs in any order.
//   - edge decls: `a -> b [attrs]` and chained `a -> b -> c [attrs]`
//   - quoted string values (with escape sequences)
//   - bare scalar values
//
// Does NOT support: `node [shape=…]` defaults blocks, subgraph clusters,
// HTML-shaped labels, port specifiers. Tests that rely on those were
// retired with the DOT parser.

const DOT_TYPE_FROM_SHAPE: Readonly<Record<string, string>> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "llm",
  hexagon: "human",
  parallelogram: "tool",
};

interface ParsedAttrs {
  // Raw key→value map (values already unescaped).
  pairs: Array<[string, string | number | boolean]>;
}

/** Lower a workflow source to YAML if it looks like DOT; pass-through
 * otherwise. Convenience for tests that store either format. */
export function lowerIfDot(source: string): string {
  return source.trimStart().startsWith("digraph") ? dotToYaml(source) : source;
}

/** Convert a DOT string in the supported subset to a YAML workflow
 * source consumable by `parseWorkflow`. */
export function dotToYaml(dot: string): string {
  // Strip comments.
  const stripped = dot
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  // Find the digraph body.
  const bodyMatch = stripped.match(/digraph\s*(?:[A-Za-z_][\w]*\s*)?\{([\s\S]*)\}\s*$/);
  if (!bodyMatch) throw new Error("dotToYaml: no `digraph { ... }` body found");
  const body = bodyMatch[1] ?? "";

  // Tokenize statements: top-level split on `;` and newlines, respecting
  // brackets + quotes.
  const stmts = splitStatements(body);

  const graphAttrs: ParsedAttrs = { pairs: [] };
  const nodes = new Map<string, ParsedAttrs>();
  const nodeOrder: string[] = [];
  type EdgeRec = { from: string; to: string; attrs: ParsedAttrs };
  const edges: EdgeRec[] = [];

  for (const raw of stmts) {
    const stmt = raw.trim();
    if (!stmt) continue;
    if (/^graph\s*\[/.test(stmt)) {
      const a = parseBracketAttrs(stmt.slice(stmt.indexOf("[")));
      graphAttrs.pairs.push(...a.pairs);
      continue;
    }
    // Edge? Look for `->` at the top level of the statement.
    if (stmt.includes("->")) {
      const arrow = splitArrow(stmt);
      // arrow is { ids: [id1, id2, ...], attrs }
      for (let i = 0; i < arrow.ids.length - 1; i++) {
        const from = arrow.ids[i];
        const to = arrow.ids[i + 1];
        if (from && to) {
          edges.push({ from, to, attrs: { pairs: [...arrow.attrs.pairs] } });
          for (const id of [from, to]) {
            if (!nodes.has(id)) {
              nodes.set(id, { pairs: [] });
              nodeOrder.push(id);
            }
          }
        }
      }
      continue;
    }
    // Node decl: `id` or `id [attrs]`.
    const nodeMatch = stmt.match(/^("[^"]+"|[A-Za-z_][\w]*)\s*(?:\[([\s\S]*)\])?\s*$/);
    if (nodeMatch) {
      const id = unquote(nodeMatch[1] ?? "");
      const attrs = nodeMatch[2] ? parseBracketAttrs(`[${nodeMatch[2]}]`) : { pairs: [] };
      const existing = nodes.get(id);
      if (existing) {
        existing.pairs.push(...attrs.pairs);
      } else {
        nodes.set(id, attrs);
        nodeOrder.push(id);
      }
      continue;
    }
    // Skip unparseable lines (graph-level attr assignment like `goal="X"`).
    const graphAttrMatch = stmt.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
    if (graphAttrMatch) {
      const k = graphAttrMatch[1] ?? "";
      const v = unquote(graphAttrMatch[2]?.trim() ?? "");
      graphAttrs.pairs.push([k, v]);
    }
  }

  // Build YAML.
  const lines: string[] = [];
  lines.push("name: t");
  for (const [k, v] of graphAttrs.pairs) {
    if (k === "label" || k === "name") continue; // YAML carries name at root
    lines.push(`${k}: ${yamlScalar(v)}`);
  }
  lines.push("nodes:");
  for (const id of nodeOrder) {
    const a = nodes.get(id)!;
    const type = pickType(a);
    lines.push(`  ${quoteId(id)}:`);
    lines.push(`    type: ${type}`);
    for (const [k, v] of a.pairs) {
      if (k === "shape") continue;
      // Re-key model_stylesheet-era model/provider that may still appear.
      lines.push(`    ${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("edges:");
  if (edges.length === 0) lines.push("  []");
  for (const e of edges) {
    const attrsInline = e.attrs.pairs
      .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
      .join(", ");
    const tail = attrsInline ? `, ${attrsInline}` : "";
    lines.push(`  - {from: ${quoteId(e.from)}, to: ${quoteId(e.to)}${tail}}`);
  }
  return lines.join("\n") + "\n";
}

// ---- internals --------------------------------------------------------

function splitStatements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? "";
    if (inStr) {
      buf += c;
      if (c === "\\" && i + 1 < body.length) {
        buf += body[i + 1];
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      buf += c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (depth === 0 && (c === ";" || c === "\n")) {
      if (buf.trim()) out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function parseBracketAttrs(s: string): ParsedAttrs {
  // s starts with `[` and ends with `]`. Extract pairs.
  const open = s.indexOf("[");
  const close = s.lastIndexOf("]");
  if (open < 0 || close < 0) return { pairs: [] };
  const inner = s.slice(open + 1, close);
  const pairs: ParsedAttrs["pairs"] = [];
  let i = 0;
  while (i < inner.length) {
    // skip whitespace + commas
    while (i < inner.length && /[\s,]/.test(inner[i] ?? "")) i++;
    if (i >= inner.length) break;
    // key
    const keyMatch = inner.slice(i).match(/^([A-Za-z_][\w]*)\s*=\s*/);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1] ?? "";
    i += keyMatch[0].length;
    // value
    let value: string;
    if (inner[i] === '"') {
      // quoted
      let end = i + 1;
      while (end < inner.length) {
        const ch = inner[end] ?? "";
        if (ch === "\\" && end + 1 < inner.length) {
          end += 2;
          continue;
        }
        if (ch === '"') break;
        end++;
      }
      value = unescape(inner.slice(i + 1, end));
      i = end + 1;
    } else {
      // bare scalar
      let end = i;
      while (end < inner.length && !/[\s,]/.test(inner[end] ?? "")) end++;
      value = inner.slice(i, end);
      i = end;
    }
    pairs.push([key, coerce(value)]);
  }
  return { pairs };
}

function splitArrow(stmt: string): { ids: string[]; attrs: ParsedAttrs } {
  // Split on `->`, optionally trailing `[attrs]`.
  const bracketIdx = stmt.indexOf("[");
  const head = bracketIdx >= 0 ? stmt.slice(0, bracketIdx).trim() : stmt.trim();
  const tail = bracketIdx >= 0 ? stmt.slice(bracketIdx) : "";
  const ids = head.split(/\s*->\s*/).map((p) => unquote(p.trim())).filter(Boolean);
  const attrs = tail ? parseBracketAttrs(tail) : { pairs: [] };
  return { ids, attrs };
}

function pickType(a: ParsedAttrs): string {
  for (const [k, v] of a.pairs) {
    if (k === "shape" && typeof v === "string") {
      const t = DOT_TYPE_FROM_SHAPE[v];
      if (t) return t;
    }
  }
  // Default: bare nodes were llm (box) under DOT.
  return "llm";
}

function unescape(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return unescape(s.slice(1, -1));
  return s;
}

function coerce(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  const n = Number(s);
  if (!Number.isNaN(n) && s.trim() !== "" && /^-?\d+(\.\d+)?$/.test(s)) return n;
  return s;
}

function yamlScalar(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // Strings: prefer flow if simple, quoted JSON if contains newlines or special chars.
  if (/[\n":{}\[\],&*#?|<>=!%@`]/.test(v) || /^\s|\s$/.test(v) || /^[-?]/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function quoteId(id: string): string {
  return /^[A-Za-z_][\w]*$/.test(id) ? id : JSON.stringify(id);
}

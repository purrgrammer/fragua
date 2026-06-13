// Structural lint — W013 whitelist drift.
//
// The validator's KNOWN_NODE_ATTRS / KNOWN_EDGE_ATTRS / KNOWN_GRAPH_ATTRS
// whitelists (engine/validator.ts) are hand-maintained copies of the field
// sets declared on NodeAttrs / EdgeAttrs / GraphAttrs (types/graph.ts) —
// the canonical IR attribute vocabulary the parser lowers authoring keys
// into. When a field is added to an interface but not to its whitelist,
// W013 starts flagging a legitimate attribute; when a whitelist keeps a
// name the interface dropped, a typo of that name sails through silently.
// This test derives the expected sets from the interface declarations and
// fails on drift in either direction.
//
// Like the other lint tests (packages/store/test/lint.test.ts,
// packages/core/test/handler/discipline.test.ts) this is a conservative
// source-text extraction, not a full AST parse — the interfaces are flat
// property lists and the whitelists are literal `new Set([...])` arrays,
// so a brace-depth-aware line scan is sufficient and self-checks below
// guard the extractors themselves.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GRAPH_TS = readFileSync(join(__dirname, "..", "src", "types", "graph.ts"), "utf8");
const VALIDATOR_TS = readFileSync(join(__dirname, "..", "src", "engine", "validator.ts"), "utf8");
const PARSER_TS = readFileSync(join(__dirname, "..", "src", "parser", "yaml.ts"), "utf8");

/** Whitelist entries that are deliberately NOT interface fields. `type` is a
 * STEP_RESERVED authoring key (it lives on Node, not NodeAttrs), but the
 * parser's `defaults:` backfill copies default entries into attrs without
 * filtering STEP_RESERVED — so a defaults-provided `type` can land in attrs
 * and must not trip W013. */
const NODE_ATTR_EXCEPTIONS: ReadonlySet<string> = new Set(["type"]);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function matchBrace(source: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level property names of an `export interface <name> { ... }` block. */
function interfaceFields(source: string, name: string): Set<string> {
  const head = new RegExp(`export interface ${name}\\s*\\{`).exec(source);
  if (!head) throw new Error(`interface ${name} not found`);
  const start = head.index + head[0].length;
  const end = matchBrace(source, start - 1);
  if (end < 0) throw new Error(`interface ${name}: unbalanced braces`);
  const body = stripComments(source.slice(start, end));
  const fields = new Set<string>();
  let depth = 0;
  for (const line of body.split("\n")) {
    if (depth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line);
      if (m) fields.add(m[1]!);
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  if (fields.size === 0) throw new Error(`interface ${name}: extracted zero fields — extractor broken?`);
  return fields;
}

/** String members of a `const <name>... = new Set([ ... ])` literal. */
function setLiteral(source: string, constName: string): Set<string> {
  const head = new RegExp(`const ${constName}[^=]*=\\s*new Set\\(\\[`).exec(source);
  if (!head) throw new Error(`const ${constName} = new Set([...]) not found`);
  const start = head.index + head[0].length;
  const end = source.indexOf("])", start);
  if (end < 0) throw new Error(`const ${constName}: unterminated Set literal`);
  const body = stripComments(source.slice(start, end));
  const out = new Set<string>();
  for (const m of body.matchAll(/"([^"]+)"/g)) out.add(m[1]!);
  if (out.size === 0) throw new Error(`const ${constName}: extracted zero entries — extractor broken?`);
  return out;
}

/** String values of a `const <name>... = { k: "v", ... }` record literal. */
function recordValues(source: string, constName: string): Set<string> {
  const head = new RegExp(`const ${constName}[^=]*=\\s*\\{`).exec(source);
  if (!head) throw new Error(`const ${constName} = {...} not found`);
  const start = head.index + head[0].length;
  const end = matchBrace(source, start - 1);
  if (end < 0) throw new Error(`const ${constName}: unbalanced braces`);
  const body = stripComments(source.slice(start, end));
  const out = new Set<string>();
  for (const m of body.matchAll(/:\s*"([^"]+)"/g)) out.add(m[1]!);
  if (out.size === 0) throw new Error(`const ${constName}: extracted zero values — extractor broken?`);
  return out;
}

function diffSets(expected: ReadonlySet<string>, actual: ReadonlySet<string>): { missing: string[]; stale: string[] } {
  return {
    missing: [...expected].filter((k) => !actual.has(k)).sort(),
    stale: [...actual].filter((k) => !expected.has(k)).sort(),
  };
}

function assertNoDrift(
  whitelistName: string,
  interfaceName: string,
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
): void {
  const { missing, stale } = diffSets(expected, actual);
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `  missing from ${whitelistName} (declared on ${interfaceName} but not whitelisted — W013 will flag legitimate workflows):\n` +
        missing.map((k) => `    "${k}",`).join("\n"),
    );
  }
  if (stale.length > 0) {
    problems.push(
      `  stale in ${whitelistName} (whitelisted but not declared on ${interfaceName} — typos of these names escape W013):\n` +
        stale.map((k) => `    "${k}",`).join("\n"),
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${whitelistName} (engine/validator.ts) has drifted from ${interfaceName} (types/graph.ts):\n${problems.join("\n")}`,
    );
  }
  expect(missing).toHaveLength(0);
  expect(stale).toHaveLength(0);
}

describe("W013 whitelists track the IR attribute interfaces", () => {
  test("KNOWN_NODE_ATTRS matches NodeAttrs fields (+ documented exceptions)", () => {
    const expected = new Set([...interfaceFields(GRAPH_TS, "NodeAttrs"), ...NODE_ATTR_EXCEPTIONS]);
    assertNoDrift("KNOWN_NODE_ATTRS", "NodeAttrs", expected, setLiteral(VALIDATOR_TS, "KNOWN_NODE_ATTRS"));
  });

  test("KNOWN_EDGE_ATTRS matches EdgeAttrs fields", () => {
    assertNoDrift(
      "KNOWN_EDGE_ATTRS",
      "EdgeAttrs",
      interfaceFields(GRAPH_TS, "EdgeAttrs"),
      setLiteral(VALIDATOR_TS, "KNOWN_EDGE_ATTRS"),
    );
  });

  test("KNOWN_GRAPH_ATTRS matches GraphAttrs fields", () => {
    assertNoDrift(
      "KNOWN_GRAPH_ATTRS",
      "GraphAttrs",
      interfaceFields(GRAPH_TS, "GraphAttrs"),
      setLiteral(VALIDATOR_TS, "KNOWN_GRAPH_ATTRS"),
    );
  });

  // The parser's lowering table is the other half of the contract: every IR
  // key it produces must be a NodeAttrs field (or a documented exception),
  // otherwise the parser emits attrs the validator immediately flags.
  test("every STEP_KEY_TO_IR value is a NodeAttrs field", () => {
    const fields = new Set([...interfaceFields(GRAPH_TS, "NodeAttrs"), ...NODE_ATTR_EXCEPTIONS]);
    const unknown = [...recordValues(PARSER_TS, "STEP_KEY_TO_IR")].filter((v) => !fields.has(v)).sort();
    if (unknown.length > 0) {
      throw new Error(
        `STEP_KEY_TO_IR (parser/yaml.ts) lowers to IR keys not declared on NodeAttrs (types/graph.ts):\n` +
          unknown.map((k) => `  "${k}"`).join("\n"),
      );
    }
    expect(unknown).toHaveLength(0);
  });

  test("every GRAPH_KEY_TO_IR value is a GraphAttrs field", () => {
    const fields = interfaceFields(GRAPH_TS, "GraphAttrs");
    const unknown = [...recordValues(PARSER_TS, "GRAPH_KEY_TO_IR")].filter((v) => !fields.has(v)).sort();
    if (unknown.length > 0) {
      throw new Error(
        `GRAPH_KEY_TO_IR (parser/yaml.ts) lowers to IR keys not declared on GraphAttrs (types/graph.ts):\n` +
          unknown.map((k) => `  "${k}"`).join("\n"),
      );
    }
    expect(unknown).toHaveLength(0);
  });
});

describe("extractor self-checks (synthetic sources)", () => {
  const synthetic = `
    /** doc */
    export interface NodeAttrs {
      label?: string;
      /** comment with fake?: field */
      max_ms?: number; // trailing fake2?: field
      nested?: { inner: string };
      routes?: string[];
    }
  `;

  test("interfaceFields extracts top-level names, skips comments and nested fields", () => {
    const fields = interfaceFields(synthetic, "NodeAttrs");
    expect([...fields].sort()).toEqual(["label", "max_ms", "nested", "routes"]);
  });

  test("setLiteral extracts string members across lines and comments", () => {
    const src = `const KNOWN_NODE_ATTRS: ReadonlySet<string> = new Set([
      "label",
      // "commented_out",
      "type",
    ]);`;
    expect([...setLiteral(src, "KNOWN_NODE_ATTRS")].sort()).toEqual(["label", "type"]);
  });

  test("recordValues extracts mapped IR values including quoted keys", () => {
    const src = `const STEP_KEY_TO_IR: Readonly<Record<string, string>> = {
      prompt: "prompt",
      "allowed-tools": "allowed_tools",
    };`;
    expect([...recordValues(src, "STEP_KEY_TO_IR")].sort()).toEqual(["allowed_tools", "prompt"]);
  });

  test("drift is detected in both directions", () => {
    const expected = new Set(["a", "b"]);
    const actual = new Set(["b", "c"]);
    const { missing, stale } = diffSets(expected, actual);
    expect(missing).toEqual(["a"]);
    expect(stale).toEqual(["c"]);
  });
});

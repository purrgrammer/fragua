// Round-trip + loc-stripping tests for the canonical IR codec (proposal
// workflow-ir, move A). The invariant: deserialize(serialize(parse(src))) is
// executor-equivalent to parse(src) — i.e. equal modulo `loc`, which is
// validator-only metadata that must NOT survive into the persisted IR.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sourceHashGate } from "@fragua/test-utils";
import { CURRENT_IR_VERSION, convertIr, deserializeGraph, serializeGraph, stripLoc } from "../src/ir.ts";
import { parseWorkflow } from "../src/parser/yaml.ts";

const FIXTURES: Record<string, string> = {
  "single llm step": `name: solo
steps:
  work: {type: llm, prompt: do it}
`,
  "multi-step with outcome + route edges": `name: pipeline
steps:
  plan:
    type: llm
    prompt: plan it
    routes: {build: impl, finish: done}
  impl:
    type: llm
    prompt: build it
    on: {success: verify, fail: plan}
  verify: {type: tool, run: "make test"}
  done: {type: exit}
`,
  "inputs block + numeric/array attrs": `name: configured
inputs:
  ticket: {type: string, required: true}
  dry_run: {type: boolean, default: false}
defaults:
  model: claude-opus-4-7
  provider: anthropic
steps:
  impl:
    type: llm
    prompt: "fix \${{ inputs.ticket }}"
    allowed-tools: [read, write, bash]
    context-files: [docs/A.md, docs/B.md]
    max_cost_usd: 1.5
    max-retries: 3
    next: exit
`,
};

describe("IR codec — round-trip modulo loc", () => {
  for (const [label, source] of Object.entries(FIXTURES)) {
    test(`${label}: deserialize(serialize(parse)) ≡ stripLoc(parse)`, () => {
      const parsed = parseWorkflow(source);
      const roundTripped = deserializeGraph(serializeGraph(parsed));
      expect(roundTripped).toEqual(stripLoc(parsed));
    });

    test(`${label}: serialized IR carries no "loc" key`, () => {
      const ir = serializeGraph(parseWorkflow(source));
      expect(ir).not.toContain('"loc"');
    });
  }

  test("stripLoc removes loc from nodes and edges but preserves everything else", () => {
    const parsed = parseWorkflow(FIXTURES["multi-step with outcome + route edges"]!);
    // parse output carries loc on real (authored) nodes/edges
    const hadLoc = Object.values(parsed.nodes).some((n) => n.loc != null) || parsed.edges.some((e) => e.loc != null);
    expect(hadLoc).toBe(true);

    const stripped = stripLoc(parsed);
    expect(Object.values(stripped.nodes).every((n) => n.loc === undefined)).toBe(true);
    expect(stripped.edges.every((e) => e.loc === undefined)).toBe(true);
    // identity + structure intact
    expect(stripped.id).toBe(parsed.id);
    expect(Object.keys(stripped.nodes).sort()).toEqual(Object.keys(parsed.nodes).sort());
    expect(stripped.edges.length).toBe(parsed.edges.length);
  });

  test("stripLoc does not mutate the input graph", () => {
    const parsed = parseWorkflow(FIXTURES["single llm step"]!);
    const before = JSON.stringify(parsed);
    stripLoc(parsed);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("CURRENT_IR_VERSION is 3 (run-level outputs bump)", () => {
    expect(CURRENT_IR_VERSION).toBe(3);
  });
});

// IR-converter version discipline — the IR analogue of the event-contract gate
// (packages/store/test/contract-version.test.ts). The `toBe(3)` test above
// catches bumping CURRENT_IR_VERSION without updating the test; it does NOT
// catch the reverse — adding/altering an IR converter `case` WITHOUT bumping
// the version. A resume against persisted IR could then mis-convert, because
// the version says "no migration needed" while the converter chain changed.
//
// This snapshots a hash over the converter chain (the `IR_CONVERTERS` array and
// `convertIr` walk) and fails the build when it moves unless CURRENT_IR_VERSION
// and the snapshot move in the same diff. It does not DECIDE the bump — it
// turns "silently forgot" into "build red until you consciously choose bump vs.
// re-snapshot-only".
// Mechanics live in the shared `sourceHashGate` helper.
describe("IR-converter version discipline", () => {
  test("converter chain matches the snapshot", () => {
    sourceHashGate({
      srcPath: join(__dirname, "..", "src", "ir.ts"),
      declNames: ["IR_CONVERTERS", "convertIr"],
      snapshotPath: join(__dirname, "ir-converters.snapshot.json"),
      envVar: "UPDATE_IR_SNAPSHOT",
      version: CURRENT_IR_VERSION,
      errorPrefix: "ir-converters",
      bumpHint: [
        "IR converter chain changed (the IR_CONVERTERS array or convertIr walk).",
        "",
        "If this changes how persisted IR migrates: bump CURRENT_IR_VERSION in",
        "packages/core/src/ir.ts (and the toBe(...) assertion in ir.test.ts), then re-snapshot:",
        "  UPDATE_IR_SNAPSHOT=1 bun test packages/core/test/ir.test.ts",
        "",
        "If it is migration-invariant (a comment, a reorder of identity converters):",
        "re-snapshot the same way and note why no bump was needed.",
      ].join("\n"),
    });
  });
});

describe("ir_version v2 → v3 (run-level outputs)", () => {
  test("convertIr lifts a v2 IR (no run-level outputs) to v3 unchanged", () => {
    const v2 = JSON.parse(serializeGraph(parseWorkflow(FIXTURES["single llm step"]!)));
    const { json, version } = convertIr(v2, 2);
    expect(version).toBe(3);
    expect(json).toEqual(v2); // additive: the v2→v3 converter is identity
  });

  test("convertIr walks the whole chain v1 → v3", () => {
    const v1 = JSON.parse(serializeGraph(parseWorkflow(FIXTURES["single llm step"]!)));
    const { json, version } = convertIr(v1, 1);
    expect(version).toBe(3);
    expect(json).toEqual(v1);
  });

  test("a v3 IR round-trips graph.attrs.outputs through serialize/deserialize", () => {
    const src = [
      "name: wf",
      "outputs:",
      "  verdict: { from: review.verdict }",
      "steps:",
      "  review:",
      "    type: llm",
      "    prompt: Review.",
      "    outputs:",
      "      verdict: { type: string }",
      "    next: exit",
    ].join("\n");
    const parsed = parseWorkflow(src);
    const roundTripped = deserializeGraph(serializeGraph(parsed));
    expect(roundTripped.attrs.outputs).toEqual([{ name: "verdict", node: "review", path: ["verdict"] }]);
  });
});

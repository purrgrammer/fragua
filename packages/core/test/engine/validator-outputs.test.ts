import { describe, expect, test } from "bun:test";
import { validate } from "../../src/engine/validator.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

/** Parse a workflow YAML and collect diagnostics. */
function diags(yaml: string) {
  const g = parseWorkflow(yaml);
  return validate(g);
}

// Build a ${{ outputs.X.f }} token. Use \$ to avoid Biome treating ${{ as a
// template expression.
const OUT = (producer: string, field: string) => `\${{ outputs.${producer}.${field} }}`;

// ─────────────── outputs only on producing steps (parse-time) ───────────────

describe("outputs placement", () => {
  test("outputs: on a human step is rejected at parse time", () => {
    const src = [
      "name: wf",
      "steps:",
      "  gate:",
      "    type: human",
      "    text: proceed?",
      "    outputs:",
      "      decision: { type: string }",
      "    routes:",
      "      yes: { to: exit }",
      "      no: { to: exit }",
    ].join("\n");
    expect(() => parseWorkflow(src)).toThrow(/outputs/);
  });
});

// ─────────────── E033/E034 static profile validation ───────────────

describe("E034 — empty outputs declaration", () => {
  test("no diagnostics for valid outputs", () => {
    const src = `
name: wf
steps:
  produce:
    type: llm
    prompt: Produce.
    outputs:
      pr_number:
        type: string
    next: exit
`;
    const d = diags(src);
    expect(d.filter((x) => x.code === "E034")).toHaveLength(0);
  });
});

// ─────────────── E035 / W015 — outputs reference checks ───────────────
// Reads fail closed at runtime, so static checks are advisory: E035 hard-errors
// only on a broken reference (missing producer/field, or a producer that can
// never reach the consumer); W015 warns when the producer can reach the
// consumer but doesn't run on every path to it (might be unpopulated → fails
// closed). A consumer reachable only on paths where the producer already ran
// (including the producer's own fail edge) stays silent.

describe("E035 / W015 — outputs references", () => {
  test("producer dominates consumer — no E035, no W015", () => {
    // A -> B linear chain: A dominates B
    const outRef = OUT("scope", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce pr_number.",
      "    outputs:",
      "      pr_number:",
      "        type: string",
      "    next: merge",
      "  merge:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    expect(d.filter((x) => x.code === "W015")).toHaveLength(0);
  });

  test("dotted leaf into a non-existent record field — E035", () => {
    // scope.meta is a record declaring `pkg`; `ghost` is not a field of it.
    // The top field (`meta`) exists, so only a deeper-segment walk catches this.
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce meta.",
      "    outputs:",
      "      meta:",
      "        type: object",
      "        fields:",
      "          pkg: { type: string }",
      "    next: use",
      "  use:",
      "    type: tool",
      "    run: echo \\${{ outputs.scope.meta.ghost }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035").length).toBeGreaterThan(0);
  });

  test("valid dotted leaf into a declared record field — no E035", () => {
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce meta.",
      "    outputs:",
      "      meta:",
      "        type: object",
      "        fields:",
      "          pkg: { type: string }",
      "    next: use",
      "  use:",
      "    type: tool",
      "    run: echo \\${{ outputs.scope.meta.pkg }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
  });

  test("fail-edge consumer ALSO reachable bypassing the producer — W015 warning, not error", () => {
    // The consumer sits on the producer's fail edge, but a triage route can
    // also reach it without the producer ever running — the bypass path is
    // what W015 must keep flagging.
    const outRef = OUT("scope", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  triage:",
      "    type: llm",
      "    prompt: Triage.",
      "    routes:",
      "      go: scope",
      "      skip: consumer",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      pr_number:",
      "        type: string",
      "    on:",
      "      success: exit",
      "      fail: consumer",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    const w15 = d.filter((x) => x.code === "W015");
    expect(w15.length).toBeGreaterThan(0);
    expect(w15[0]?.severity).toBe("warning");
  });

  test("consumer on the producer's OWN fail edge — producer already ran, no W015", () => {
    // The `dependencies` shape that surfaced the false positive: the producer
    // routes `on: {success, fail}` and the fail-edge consumer reads the
    // producer's output. Every path to the consumer crosses the producer (it
    // has already run), so W015 must stay silent — the read fails closed at
    // runtime only in the emitted-nothing edge case, which is not a
    // not-on-every-path wiring problem.
    const outRef = OUT("update", "bumps");
    const src = [
      "name: wf",
      "steps:",
      "  update:",
      "    type: llm",
      "    prompt: Update deps.",
      "    outputs:",
      "      bumps:",
      "        type: string",
      "    on:",
      "      success: exit",
      "      fail: report",
      "  report:",
      "    type: tool",
      `    run: echo ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    expect(d.filter((x) => x.code === "W015")).toHaveLength(0);
  });

  test("recovery step reached via ANOTHER node's fail edge, producer dominates — no W015", () => {
    // A producer runs, a deterministic gate fails, and a recovery step
    // (reached via the GATE's fail edge, not the producer's) reads the
    // producer's output. The producer dominates the recovery step — every
    // path to it crosses the producer — so the ref is populated. Dominance
    // must see through the gate's fail edge.
    const outRef = OUT("update", "bumps");
    const src = [
      "name: wf",
      "steps:",
      "  update:",
      "    type: llm",
      "    prompt: Update.",
      "    outputs:",
      "      bumps:",
      "        type: string",
      "    next: gate",
      "  gate:",
      "    type: tool",
      "    run: bun run ci",
      "    on:",
      "      success: exit",
      "      fail: fix",
      "  fix:",
      "    type: llm",
      `    prompt: Fix per ${outRef}.`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    expect(d.filter((x) => x.code === "W015")).toHaveLength(0);
  });

  test("producer dominates a recovery step reached via a gate's fail edge — no W015", () => {
    // `update` (non-routing) dominates `fix` even though `fix` is reached
    // only via `gate`'s fail edge — every path to `fix` runs `update` first. The
    // fail-path is what the W015 dominance check must not false-positive on.
    const outRef = OUT("update", "bumps");
    const src = [
      "name: wf",
      "steps:",
      "  update:",
      "    type: llm",
      "    prompt: Update.",
      "    outputs:",
      "      bumps:",
      "        type: string",
      "    next: gate",
      "  gate:",
      "    type: tool",
      "    run: bun run ci",
      "    on:",
      "      success: exit",
      "      fail: fix",
      "  fix:",
      "    type: llm",
      `    prompt: Fix per ${outRef}.`,
      "    on:",
      "      success: gate",
      "      fail: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    expect(d.filter((x) => x.code === "W015")).toHaveLength(0);
  });

  test("producer not on all paths — W015 warning, not error", () => {
    const outRef = OUT("producer", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  triage:",
      "    type: llm",
      "    prompt: Triage.",
      "    routes:",
      "      full: producer",
      "      quick: consumer",
      "  producer:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      pr_number:",
      "        type: string",
      "    next: consumer",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    const w15 = d.filter((x) => x.code === "W015");
    expect(w15.length).toBeGreaterThan(0);
    expect(w15[0]?.severity).toBe("warning");
  });

  test("producer can never reach consumer (divergent branches) — E035 dead-ref", () => {
    const outRef = OUT("producer", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  triage:",
      "    type: llm",
      "    routes:",
      "      a: producer",
      "      b: consumer",
      "  producer:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      pr_number:",
      "        type: string",
      "    next: exit",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035").length).toBeGreaterThan(0);
  });

  test("referencing a producer that does not exist — E035", () => {
    const outRef = OUT("nonexistent", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    const e35 = d.filter((x) => x.code === "E035");
    expect(e35.length).toBeGreaterThan(0);
    expect(e35[0]!.message).toContain("nonexistent");
  });

  test("referencing undeclared output field on a dominating producer — E035", () => {
    const outRef = OUT("scope", "loc");
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      pr_number:",
      "        type: string",
      "    next: consumer",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    const e35 = d.filter((x) => x.code === "E035");
    expect(e35.length).toBeGreaterThan(0);
    expect(e35[0]!.message).toContain("loc");
  });

  test("referencing a node with no outputs: declaration — E035", () => {
    const outRef = OUT("scope", "pr_number");
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    next: consumer",
      "  consumer:",
      "    type: tool",
      `    run: gh pr merge ${outRef}`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    const e35 = d.filter((x) => x.code === "E035");
    expect(e35.length).toBeGreaterThan(0);
  });

  test("llm consuming outputs from dominating llm — no E035", () => {
    const outRef = OUT("scope", "summary");
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      summary:",
      "        type: string",
      "    next: review",
      "  review:",
      "    type: llm",
      `    prompt: "Review: ${outRef}"`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
  });

  test("tool consuming outputs from a dominating llm — no E035", () => {
    const outRef = OUT("collect", "total");
    const src = [
      "name: wf",
      "steps:",
      "  collect:",
      "    type: llm",
      "    prompt: Count.",
      "    outputs:",
      "      total:",
      "        type: number",
      "    next: report",
      "  report:",
      "    type: tool",
      `    run: echo "total=${outRef}"`,
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
  });
});

// ─────────────── W016 — direct read of an optional field ───────────────
// A `${{ outputs.X.f }}` that reaches THROUGH an optional field fails closed at
// runtime whenever the producer omits it. Advisory only (runtime fail-closed is
// the real gate) and mutually exclusive with W015 per ref — when the producer
// also might-not-run, W015 wins and W016 stays quiet. The safe shapes (a
// required field with a sentinel, or an optional field read inside a whole
// record/array) draw no W016.

describe("W016 — optional-field reads", () => {
  test("direct read of an optional record subfield (producer dominates) — W016, no W015", () => {
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      meta:",
      "        type: object",
      "        fields:",
      "          pkg: { type: string }",
      "          ver: { type: string, optional: true }",
      "    next: use",
      "  use:",
      "    type: tool",
      "    run: echo \\${{ outputs.scope.meta.ver }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
    expect(d.filter((x) => x.code === "W015")).toHaveLength(0);
    const w16 = d.filter((x) => x.code === "W016");
    expect(w16.length).toBeGreaterThan(0);
    expect(w16[0]?.severity).toBe("warning");
    expect(w16[0]?.message).toContain("ver");
  });

  test("an optional field inside an array, read as the WHOLE array — no W016 (the safe shape)", () => {
    // The review.yaml pattern: `fix` is optional per finding, but the consumer
    // reads the whole `findings` array (a required top-level field) as JSON.
    const src = [
      "name: wf",
      "steps:",
      "  lens:",
      "    type: llm",
      "    prompt: Review.",
      "    outputs:",
      "      findings:",
      "        type: array",
      "        items:",
      "          type: object",
      "          fields:",
      "            title: { type: string }",
      "            fix: { type: string, optional: true }",
      "    next: synth",
      "  synth:",
      "    type: llm",
      "    prompt: 'Findings: \\${{ outputs.lens.findings }}'",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "W016")).toHaveLength(0);
    expect(d.filter((x) => x.code === "E035")).toHaveLength(0);
  });

  test("an optional INTERMEDIATE segment also trips W016 (anything beneath it can vanish)", () => {
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      outer:",
      "        type: object",
      "        fields:",
      "          inner:",
      "            type: object",
      "            optional: true",
      "            fields:",
      "              x: { type: string }",
      "    next: use",
      "  use:",
      "    type: tool",
      "    run: echo \\${{ outputs.scope.outer.inner.x }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    const w16 = d.filter((x) => x.code === "W016");
    expect(w16.length).toBeGreaterThan(0);
    expect(w16[0]?.message).toContain("inner");
  });

  test("a required-only dotted path (producer dominates) — no W016", () => {
    const src = [
      "name: wf",
      "steps:",
      "  scope:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      meta:",
      "        type: object",
      "        fields:",
      "          pkg: { type: string }",
      "    next: use",
      "  use:",
      "    type: tool",
      "    run: echo \\${{ outputs.scope.meta.pkg }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "W016")).toHaveLength(0);
  });

  test("optional field but producer does NOT dominate — W015 only, never both", () => {
    const src = [
      "name: wf",
      "steps:",
      "  triage:",
      "    type: llm",
      "    prompt: Triage.",
      "    routes:",
      "      full: producer",
      "      quick: consumer",
      "  producer:",
      "    type: llm",
      "    prompt: Produce.",
      "    outputs:",
      "      meta:",
      "        type: object",
      "        fields:",
      "          ver: { type: string, optional: true }",
      "    next: consumer",
      "  consumer:",
      "    type: tool",
      "    run: echo \\${{ outputs.producer.meta.ver }}",
      "    next: exit",
    ].join("\n");
    const d = diags(src);
    expect(d.filter((x) => x.code === "W015").length).toBeGreaterThan(0);
    expect(d.filter((x) => x.code === "W016")).toHaveLength(0);
  });
});

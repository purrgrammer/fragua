import { describe, expect, test } from "bun:test";
import type { IEventStore } from "@fragua/store";
import type { IntentEvent } from "@fragua/types";
import { sha256Hex } from "../../src/handler/sha256.ts";
import { makeIntentPlane } from "../../src/intent-plane/index.ts";
import { pointerToFieldPath } from "../../src/intent-plane/plane.ts";
import { CURRENT_IR_VERSION, serializeGraph } from "../../src/ir.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

// build* never touches the store, so a stub that records appendIntent is
// enough for the whole suite. The pure build half is what we exhaustively
// cover; commit is a single passthrough, smoke-tested at the end.
function rig() {
  const appended: { runId: string; intent: IntentEvent }[] = [];
  const store = {
    appendIntent(runId: string, intent: IntentEvent) {
      appended.push({ runId, intent });
      return { seq: appended.length, ts: 0 };
    },
  } as unknown as IEventStore;
  let n = 0;
  const newRunId = () => `run-${++n}`;
  return { plane: makeIntentPlane({ store, newRunId }), appended };
}

describe("intent plane — build* (validate + construct)", () => {
  test("steer: text required, constructs intent.steering_requested", () => {
    const { plane } = rig();
    expect(plane.buildSteer({ text: "go left" })).toEqual({
      ok: true,
      intent: { type: "intent.steering_requested", payload: { text: "go left" } },
    });
    expect(plane.buildSteer({ text: "" }).ok).toBe(false);
    expect(plane.buildSteer({}).ok).toBe(false);
    expect(plane.buildSteer({ text: "x", extra: 1 }).ok).toBe(false); // additionalProperties
  });

  test("pause: empty body, constructs intent.pause_requested", () => {
    const { plane } = rig();
    expect(plane.buildPause({})).toEqual({ ok: true, intent: { type: "intent.pause_requested", payload: {} } });
    expect(plane.buildPause({ nope: 1 }).ok).toBe(false);
  });

  test("cancel: optional reason omitted when absent", () => {
    const { plane } = rig();
    expect(plane.buildCancel({})).toEqual({ ok: true, intent: { type: "intent.cancel_requested", payload: {} } });
    expect(plane.buildCancel({ reason: "obsolete" })).toEqual({
      ok: true,
      intent: { type: "intent.cancel_requested", payload: { reason: "obsolete" } },
    });
  });

  test("human: route required (non-empty), note optional", () => {
    const { plane } = rig();
    expect(plane.buildHuman({ route: "approve" })).toEqual({
      ok: true,
      intent: { type: "intent.human_input", payload: { route: "approve" } },
    });
    expect(plane.buildHuman({ route: "approve", note: "lgtm" })).toEqual({
      ok: true,
      intent: { type: "intent.human_input", payload: { route: "approve", note: "lgtm" } },
    });
    expect(plane.buildHuman({}).ok).toBe(false);
    expect(plane.buildHuman({ route: "" }).ok).toBe(false);
  });

  test("resume: optional note", () => {
    const { plane } = rig();
    expect(plane.buildResume({})).toEqual({ ok: true, intent: { type: "intent.resume", payload: {} } });
    expect(plane.buildResume({ note: "fixed creds" }).ok).toBe(true);
  });

  test("unquarantine: resolution ∈ enum", () => {
    const { plane } = rig();
    expect(plane.buildUnquarantine({ resolution: "retry" })).toEqual({
      ok: true,
      intent: { type: "intent.unquarantine", payload: { resolution: "retry" } },
    });
    expect(plane.buildUnquarantine({ resolution: "treat_as_done", note: "verified" }).ok).toBe(true);
    expect(plane.buildUnquarantine({ resolution: "bogus" }).ok).toBe(false);
    expect(plane.buildUnquarantine({}).ok).toBe(false);
  });

  test("priority: newPriority is any number (incl. negative)", () => {
    const { plane } = rig();
    expect(plane.buildPriority({ newPriority: 10 })).toEqual({
      ok: true,
      intent: { type: "intent.priority_adjusted", payload: { newPriority: 10 } },
    });
    expect(plane.buildPriority({ newPriority: -5 }).ok).toBe(true);
    expect(plane.buildPriority({}).ok).toBe(false);
    expect(plane.buildPriority({ newPriority: "10" }).ok).toBe(false);
  });

  test("budget: scope/metric enums + newLimit > 0 finite", () => {
    const { plane } = rig();
    expect(plane.buildBudget({ scope: "run", metric: "cost", newLimit: 5 })).toEqual({
      ok: true,
      intent: { type: "intent.budget_adjusted", payload: { scope: "run", metric: "cost", newLimit: 5 } },
    });
    for (const bad of [
      { scope: "global", metric: "cost", newLimit: 5 },
      { scope: "run", metric: "time", newLimit: 5 },
      { scope: "run", metric: "cost", newLimit: 0 },
      { scope: "run", metric: "cost", newLimit: -1 },
      { scope: "run", metric: "cost", newLimit: Number.POSITIVE_INFINITY },
      { scope: "run", metric: "cost" },
    ]) {
      expect(plane.buildBudget(bad).ok).toBe(false);
    }
  });

  test("max_retries / goal_gate / max_loops: newLimit > 0; max_retries needs nodeId", () => {
    const { plane } = rig();
    expect(plane.buildMaxRetries({ nodeId: "build", newLimit: 3 }).ok).toBe(true);
    expect(plane.buildMaxRetries({ newLimit: 3 }).ok).toBe(false);
    expect(plane.buildMaxRetries({ nodeId: "", newLimit: 3 }).ok).toBe(false);
    expect(plane.buildGoalGate({ newLimit: 2 }).ok).toBe(true);
    expect(plane.buildGoalGate({ newLimit: 0 }).ok).toBe(false);
    expect(plane.buildMaxLoops({ newLimit: 20 }).ok).toBe(true);
    expect(plane.buildMaxLoops({ newLimit: -1 }).ok).toBe(false);
  });

  test("validation reports every invalid field with readable dotted paths", () => {
    const { plane } = rig();
    // Two simultaneously invalid fields: scope ∉ enum, metric ∉ enum.
    const r = plane.buildBudget({ scope: "global", metric: "time", newLimit: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("scope:");
    expect(r.error).toContain("metric:");
    // Field names, not JSON-pointer notation.
    expect(r.error).not.toContain("/scope");
    expect(r.error).not.toContain("/metric");
  });

  test("root-level errors get a 'body' label, not an empty pointer", () => {
    const { plane } = rig();
    const r = plane.buildSteer(42);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("body:");
  });

  test("pointer paths map to dotted field paths with [n] array indices", () => {
    expect(pointerToFieldPath("")).toBe("body");
    expect(pointerToFieldPath("/text")).toBe("text");
    expect(pointerToFieldPath("/limits/maxRetries")).toBe("limits.maxRetries");
    expect(pointerToFieldPath("/items/0/name")).toBe("items[0].name");
    expect(pointerToFieldPath("/0")).toBe("[0]");
  });

  test("pathological bodies cap at 10 reported errors with (+N more)", () => {
    const { plane } = rig();
    const body: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) body[`junk${i}`] = i;
    const r = plane.buildBudget(body);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.split("; ").length).toBe(10);
    expect(r.error).toMatch(/\(\+\d+ more\)$/);
  });

  test("a non-object body is rejected, not thrown", () => {
    const { plane } = rig();
    for (const body of [null, undefined, 42, "x", []]) {
      expect(plane.buildSteer(body).ok).toBe(false);
    }
  });
});

describe("intent plane — buildSaveWorkflow (workflow-identity mint)", () => {
  const SOURCE = "name: solo\nsteps:\n  work: {type: llm, prompt: do it, next: exit}\n";

  test("valid source → sha + ir + irVersion match the canonical mint exactly", () => {
    const { plane } = rig();
    const mint = plane.buildSaveWorkflow(SOURCE);
    if (!mint.ok) throw new Error("expected ok");
    // The chokepoint MUST produce the same identity the three sites computed
    // independently before consolidation — sha is FK-referenced.
    expect(mint.sha).toBe(sha256Hex(SOURCE));
    expect(mint.ir).toBe(serializeGraph(parseWorkflow(SOURCE)));
    expect(mint.irVersion).toBe(CURRENT_IR_VERSION);
    expect(mint.graph.nodes["work"]).toBeDefined();
  });

  test("unparseable source → { ok: false, reason: 'unparseable' }, never throws", () => {
    const { plane } = rig();
    const mint = plane.buildSaveWorkflow("this: is: not: a: workflow: {{{");
    expect(mint.ok).toBe(false);
    if (mint.ok) throw new Error("expected failure");
    expect(mint.reason).toBe("unparseable");
    expect(mint.detail.length).toBeGreaterThan(0);
  });

  test("parseable but validator-rejected source → { ok: false, reason: 'invalid' } with the E-codes", () => {
    // A fan-out branch that resolves to a run terminal — the exact shape the
    // executor fails closed on (fanout_branch_terminal). The mint is the
    // chokepoint every enqueue path routes through, so it must refuse first.
    const { plane } = rig();
    const mint = plane.buildSaveWorkflow(`name: bad
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, next: exit }
  b: { type: llm, prompt: x, next: synth }
  synth: { type: llm, prompt: done, next: exit }
`);
    expect(mint.ok).toBe(false);
    if (mint.ok) throw new Error("expected failure");
    expect(mint.reason).toBe("invalid");
    expect(mint.detail.length).toBeGreaterThan(0);
    expect(mint.diagnostics?.every((d) => d.severity === "error")).toBe(true);
  });

  test("warning-only diagnostics still mint (warnings are advisory)", () => {
    // W007: a goal gate without retry_target — warns, must not block the save.
    const { plane } = rig();
    const mint = plane.buildSaveWorkflow(`name: warned
steps:
  work: { type: llm, prompt: x, goal-gate: true, next: exit }
`);
    expect(mint.ok).toBe(true);
  });

  test("commitSaveWorkflow forwards to store.saveWorkflow", () => {
    const saved: unknown[] = [];
    const store = {
      saveWorkflow: (...args: unknown[]) => saved.push(args),
    } as unknown as IEventStore;
    const plane = makeIntentPlane({ store, newRunId: () => "run-x" });
    plane.commitSaveWorkflow({ sha: "abc", name: "solo", source: SOURCE, ir: "{}", irVersion: 1 });
    expect(saved).toEqual([["abc", "solo", SOURCE, "{}", 1]]);
  });
});

describe("intent plane — buildEnqueue", () => {
  const WITH_INPUTS =
    "name: cfg\ninputs:\n  ticket: {type: string, required: true}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
  const inputDecls = parseWorkflow(WITH_INPUTS).attrs.inputs;

  test("valid → params with minted runId + assembled routing", () => {
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", cwd: "/repo", projectId: "p1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.runId).toBe("run-1"); // injected counter minter
    expect(r.params).toEqual({
      runId: "run-1",
      workflowSha: "sha1",
      cwd: "/repo",
      projectId: "p1",
    });
  });

  test("missing required input → { ok: false } with inputErrors", () => {
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", inputDecls, inputs: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.inputErrors.some((e) => e.code === "missing_required" && e.name === "ticket")).toBe(true);
  });

  test("required input provided → ok; inputs land on routing", () => {
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", inputDecls, inputs: { ticket: "BUG-1" } });
    if (!r.ok) throw new Error(r.error);
    expect(r.params.initialRouting).toEqual({ inputs: { ticket: "BUG-1" } });
  });

  test("object input: parsed value validates against its profile and lands on routing", () => {
    const WITH_OBJECT =
      "name: cfg\ninputs:\n  config:\n    type: object\n    fields:\n      env: {type: choice, options: [dev, prod]}\nsteps:\n  work: {type: llm, prompt: 'env ${{ inputs.config.env }}', next: exit}\n";
    const objDecls = parseWorkflow(WITH_OBJECT).attrs.inputs;
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", inputDecls: objDecls, inputs: { config: { env: "prod" } } });
    if (!r.ok) throw new Error(r.error);
    expect(r.params.initialRouting).toEqual({ inputs: { config: { env: "prod" } } });
  });

  test("object input whose value violates its profile → { ok: false } invalid_shape", () => {
    const WITH_OBJECT =
      "name: cfg\ninputs:\n  config:\n    type: object\n    fields:\n      env: {type: choice, options: [dev, prod]}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const objDecls = parseWorkflow(WITH_OBJECT).attrs.inputs;
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", inputDecls: objDecls, inputs: { config: { env: "staging" } } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.inputErrors.some((e) => e.code === "invalid_shape" && e.name === "config")).toBe(true);
  });

  test("oversized structured inputs → clean { ok: false } validation error, not a raw throw", () => {
    const WITH_OBJECT =
      "name: cfg\ninputs:\n  config:\n    type: object\n    fields:\n      blob: {type: string}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const objDecls = parseWorkflow(WITH_OBJECT).attrs.inputs;
    const { plane } = rig();
    // A structured input isn't eligible for the routing-inputs string spill, so a
    // huge one must be rejected at build time rather than throwing PayloadTooLarge.
    const r = plane.buildEnqueue({
      workflowSha: "sha1",
      inputDecls: objDecls,
      inputs: { config: { blob: "x".repeat(8000) } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toMatch(/too large/);
    // The message must name the offending field, its measured byte size, the
    // limit, and a remedy so the caller can fix the input.
    expect(r.error).toContain('"config"');
    expect(r.error).toMatch(/\d+ bytes/);
    expect(r.error).toMatch(/3072-byte/);
    expect(r.error).toMatch(/file reference|[Tt]rim/);
    expect(r.inputErrors).toEqual([]);
  });

  test("structured inputs that JOINTLY exceed the cap (neither alone) report the combined total, not a per-field 'exceeds'", () => {
    const WITH_TWO =
      "name: cfg\ninputs:\n  a:\n    type: object\n    fields:\n      blob: {type: string}\n  b:\n    type: object\n    fields:\n      blob: {type: string}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const decls = parseWorkflow(WITH_TWO).attrs.inputs;
    const { plane } = rig();
    // Each field is ~1.7 KB (under the 3072-byte cap), but together they breach it.
    const r = plane.buildEnqueue({
      workflowSha: "sha1",
      inputDecls: decls,
      inputs: { a: { blob: "x".repeat(1700) }, b: { blob: "x".repeat(1700) } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toMatch(/too large/);
    // The message must name the COMBINED total — not claim a single field exceeds
    // a limit it doesn't individually hit.
    expect(r.error).toContain("combined structured inputs");
    expect(r.error).toMatch(/\d+ bytes/);
    expect(r.error).toMatch(/3072-byte/);
    expect(r.error).not.toMatch(/"a" \(\d+ bytes\) exceed|"b" \(\d+ bytes\) exceed/);
    expect(r.inputErrors).toEqual([]);
  });

  test("number/boolean inputs submitted as STRINGS (the web shape) coerce, validate, and land typed", () => {
    const WITH_SCALARS =
      "name: cfg\ninputs:\n  count: {type: number, required: true}\n  flag: {type: boolean, required: true}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const scalarDecls = parseWorkflow(WITH_SCALARS).attrs.inputs;
    const { plane } = rig();
    // The web UI POSTs raw strings; buildEnqueue is the shared write surface that
    // must coerce them to their declared scalar type before validation.
    const r = plane.buildEnqueue({
      workflowSha: "sha1",
      inputDecls: scalarDecls,
      inputs: { count: "42", flag: "true" },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.params.initialRouting).toEqual({ inputs: { count: 42, flag: true } });
  });

  test("number parser is decimal-only and finite: blank / Infinity / 0x reject; constructor is an own input", () => {
    const WITH_NUM =
      "name: cfg\ninputs:\n  count: {type: number}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const numDecls = parseWorkflow(WITH_NUM).attrs.inputs;
    const { plane } = rig();
    for (const bad of ["", "   ", "Infinity", "-Infinity", "NaN", "0x10", "0o7", "0b10"]) {
      const r = plane.buildEnqueue({ workflowSha: "sha1", inputDecls: numDecls, inputs: { count: bad } });
      expect(r.ok).toBe(false);
    }
    // Valid decimals (incl. scientific / fractional) coerce and land typed.
    const ok = plane.buildEnqueue({ workflowSha: "sha1", inputDecls: numDecls, inputs: { count: "1e3" } });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.params.initialRouting).toEqual({ inputs: { count: 1000 } });

    // An input literally named `constructor` reads its OWN value, not the
    // built-in off the prototype (Object.hasOwn guard).
    const WITH_CTOR =
      "name: cfg\ninputs:\n  constructor: {type: string, required: true}\nsteps:\n  work: {type: llm, prompt: do, next: exit}\n";
    const ctorDecls = parseWorkflow(WITH_CTOR).attrs.inputs;
    const missing = plane.buildEnqueue({ workflowSha: "sha1", inputDecls: ctorDecls, inputs: {} });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected failure");
    expect(missing.inputErrors.some((e) => e.code === "missing_required" && e.name === "constructor")).toBe(true);
  });

  test("runId is always minted — no operator/client-supplied id; scheduleId passes through", () => {
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", scheduleId: "sch-1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.runId).toBe("run-1"); // the injected minter, never a supplied id
    expect(r.params.scheduleId).toBe("sch-1");
  });

  test("no inputDecls → no input validation (dispatcher path)", () => {
    const { plane } = rig();
    // A workflow with required inputs but no decls passed: enqueue succeeds.
    const r = plane.buildEnqueue({ workflowSha: "sha1" });
    expect(r.ok).toBe(true);
  });

  test("commitEnqueue forwards params to store.enqueueRun", () => {
    const enqueued: unknown[] = [];
    const store = { enqueueRun: (p: unknown) => enqueued.push(p) } as unknown as IEventStore;
    const plane = makeIntentPlane({ store, newRunId: () => "run-z" });
    const r = plane.buildEnqueue({ workflowSha: "sha1" });
    if (!r.ok) throw new Error("build failed");
    plane.commitEnqueue(r.params);
    expect(enqueued).toEqual([{ runId: "run-z", workflowSha: "sha1" }]);
  });
});

describe("intent plane — commit", () => {
  test("forwards the built intent to store.appendIntent and returns seq", () => {
    const { plane, appended } = rig();
    const built = plane.buildPause({});
    if (!built.ok) throw new Error("build failed");
    const { seq } = plane.commit("run-1", built.intent);
    expect(seq).toBe(1);
    expect(appended).toEqual([{ runId: "run-1", intent: { type: "intent.pause_requested", payload: {} } }]);
  });
});

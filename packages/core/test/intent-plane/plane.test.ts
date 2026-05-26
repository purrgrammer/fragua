import { describe, expect, test } from "bun:test";
import type { IEventStore } from "@fragua/store";
import type { IntentEvent } from "@fragua/types";
import { sha256Hex } from "../../src/handler/sha256.ts";
import { makeIntentPlane } from "../../src/intent-plane/index.ts";
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

  test("a non-object body is rejected, not thrown", () => {
    const { plane } = rig();
    for (const body of [null, undefined, 42, "x", []]) {
      expect(plane.buildSteer(body).ok).toBe(false);
    }
  });
});

describe("intent plane — buildSaveWorkflow (workflow-identity mint)", () => {
  const SOURCE = "name: solo\nsteps:\n  work: {type: llm, prompt: do it}\n";

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
    "name: cfg\ninputs:\n  ticket: {type: string, required: true}\nsteps:\n  work: {type: llm, prompt: do}\n";
  const inputDecls = parseWorkflow(WITH_INPUTS).attrs.inputs;

  test("valid → params with minted runId + assembled routing", () => {
    const { plane } = rig();
    const r = plane.buildEnqueue({ workflowSha: "sha1", input: "fix the bug", cwd: "/repo", projectId: "p1" });
    if (!r.ok) throw new Error(r.error);
    expect(r.runId).toBe("run-1"); // injected counter minter
    expect(r.params).toEqual({
      runId: "run-1",
      workflowSha: "sha1",
      initialRouting: { input: "fix the bug" },
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
    const r = plane.buildEnqueue({ workflowSha: "sha1", input: "scheduled run" });
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

import { describe, expect, test } from "bun:test";
import { retryCountKey } from "@fragua/core";
import { SETTLED_STATUSES } from "@fragua/store";
import { mergeFanoutAppendOpts } from "../src/executor.ts";
import {
  buildSubstitutionArgs,
  classifyAbortCause,
  composeAbortSignals,
  deriveResumeOf,
  errorMessage,
  isAbortError,
  maxRetriesOverrideKey,
  mergeRoutingPatches,
  nodeRetryCount,
  passField,
  readBudgetOverrides,
  readBudgetWarned,
  readNumber,
  readStringMap,
  recordEdgeSelected,
  resolveBackoff,
  resolveMaxRetries,
  routingString,
  sleep,
  TERMINAL_STATUSES,
} from "../src/executor-helpers.ts";

describe("executor-helpers", () => {
  test("TERMINAL_STATUSES is derived from the canonical SETTLED_STATUSES tuple", () => {
    expect(TERMINAL_STATUSES).toEqual(new Set<string>(SETTLED_STATUSES));
    // Settled, not terminal: quarantined is included (worktree dispose +
    // terminal snapshot gate fire for it), but it stays resumable.
    expect(TERMINAL_STATUSES.has("quarantined")).toBe(true);
    expect(TERMINAL_STATUSES.has("paused_human")).toBe(false);
  });

  test("nodeRetryCount reads the per-node retry counter, not a flat key", () => {
    expect(nodeRetryCount({}, "work")).toBe(0);
    expect(nodeRetryCount({ retry_count: 3 }, "work")).toBe(0); // flat key is ignored
    expect(nodeRetryCount({ [retryCountKey("work")]: 2 }, "work")).toBe(2);
    expect(nodeRetryCount({ [retryCountKey("other")]: 2 }, "work")).toBe(0);
    expect(nodeRetryCount({ [retryCountKey("work")]: Number.NaN }, "work")).toBe(0);
  });

  test("isAbortError matches only AbortError / TimeoutError names", () => {
    const abort = new Error("x");
    abort.name = "AbortError";
    const timeout = new Error("x");
    timeout.name = "TimeoutError";
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(timeout)).toBe(true);
    expect(isAbortError(new Error("plain"))).toBe(false);
    expect(isAbortError("nope")).toBe(false);
  });

  test("classifyAbortCause prefers a TimeoutError signal reason, then the thrown name", () => {
    const timeoutReason = new Error("t");
    timeoutReason.name = "TimeoutError";
    const ac1 = new AbortController();
    ac1.abort(timeoutReason);
    expect(classifyAbortCause(ac1.signal, new Error("whatever"))).toBe("timeout");

    const ac2 = new AbortController();
    ac2.abort(new Error("operator"));
    expect(classifyAbortCause(ac2.signal, new Error("plain"))).toBe("aborted");

    const thrownTimeout = new Error("t");
    thrownTimeout.name = "TimeoutError";
    const ac3 = new AbortController();
    ac3.abort(new Error("operator"));
    expect(classifyAbortCause(ac3.signal, thrownTimeout)).toBe("timeout");
  });

  test("errorMessage unwraps Error.message, stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
  });

  test("routingString / readNumber / readStringMap coerce defensively", () => {
    expect(routingString({ a: "x" }, "a")).toBe("x");
    expect(routingString({ a: 3 }, "a")).toBeUndefined();
    expect(readNumber(5)).toBe(5);
    expect(readNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(readNumber("5")).toBe(0);
    expect(readStringMap({ a: "x", b: 2, c: "y" })).toEqual({ a: "x", c: "y" });
    expect(readStringMap(null)).toEqual({});
  });

  test("readBudgetWarned parses the dedup tag set", () => {
    expect([...readBudgetWarned({ __budget_warned: ["run:cost", "node:tokens", 7] })].sort()).toEqual([
      "node:tokens",
      "run:cost",
    ]);
    expect(readBudgetWarned({}).size).toBe(0);
  });

  test("readBudgetOverrides groups run/node cost/tokens, undefined when empty", () => {
    expect(readBudgetOverrides({})).toBeUndefined();
    expect(
      readBudgetOverrides({
        "budget_override.run.cost": 5,
        "budget_override.node.tokens": 1000,
        unrelated: "x",
      }),
    ).toEqual({ run: { cost: 5 }, node: { tokens: 1000 } });
  });

  test("maxRetriesOverrideKey is per-node", () => {
    expect(maxRetriesOverrideKey("impl")).toBe("max_retries_override.impl");
  });

  test("buildSubstitutionArgs overlays declared defaults with provided inputs", () => {
    const decls = [
      { name: "topic", type: "string" as const, required: false, default: "default-topic" },
      { name: "depth", type: "string" as const, required: false, default: "1" },
    ];
    const args = buildSubstitutionArgs({ inputs: { topic: "birds" } }, decls);
    expect(args.inputs).toEqual({ topic: "birds", depth: "1" });
    expect(buildSubstitutionArgs({}, []).inputs).toBeUndefined();
  });

  test("buildSubstitutionArgs preserves object/array input values from routing", () => {
    const decls = [
      {
        name: "config",
        type: "object" as const,
        required: false,
        profile: { kind: "record" as const, fields: { env: { kind: "string" as const } }, required: ["env"] },
      },
      {
        name: "tags",
        type: "array" as const,
        required: false,
        profile: { kind: "array" as const, items: { kind: "string" as const } },
      },
    ];
    const args = buildSubstitutionArgs({ inputs: { config: { env: "prod" }, tags: ["a", "b"] } }, decls);
    expect(args.inputs).toEqual({ config: { env: "prod" }, tags: ["a", "b"] });
  });

  test("resolveBackoff falls back to the 'none' preset and honours custom attrs", () => {
    const none = resolveBackoff({}, {});
    expect(none.initialDelayMs).toBe(0);
    const custom = resolveBackoff(
      { retry_initial_delay_ms: 250, retry_backoff_factor: 3, retry_max_delay_ms: 9000, retry_jitter: true },
      {},
    );
    expect(custom).toEqual({ initialDelayMs: 250, backoffFactor: 3, maxDelayMs: 9000, jitter: true });
  });

  test("resolveMaxRetries clamps to a non-negative integer", () => {
    expect(resolveMaxRetries({}, {})).toBe(0);
    expect(resolveMaxRetries({ max_retries: 3 }, {})).toBe(3);
    expect(resolveMaxRetries({ max_retries: 2.9 }, {})).toBe(2);
    expect(resolveMaxRetries({ max_retries: -4 }, {})).toBe(0);
  });

  test("mergeRoutingPatches returns undefined for an empty intent delta", () => {
    expect(mergeRoutingPatches({}, { kind: "transition", tokens: 0, costUsd: 0 })).toBeUndefined();
    expect(mergeRoutingPatches({ a: 1 }, { kind: "transition", tokens: 0, costUsd: 0 })).toEqual({ a: 1 });
  });

  test("recordEdgeSelected stamps the rule and optional match", () => {
    const buffer: { type: string; payload: Record<string, unknown> }[] = [];
    recordEdgeSelected(buffer, "plan", 1, { edge: { to: "impl" }, rule: "outcome", matched: "success" } as never);
    expect(buffer).toHaveLength(1);
    expect(buffer[0]).toEqual({
      type: "edge.selected",
      payload: { from: "plan", to: "impl", iteration: 1, rule: "outcome", matched: "success" },
    });
  });

  test("deriveResumeOf forwards run_resumed.fromStatus and crash, else fresh", () => {
    const store = (events: Array<{ type: string; payload: unknown }>) => ({
      getLatestEvents: () => events,
    });
    expect(deriveResumeOf(store([{ type: "fact.run_resumed", payload: { fromStatus: "paused_human" } }]), "r")).toBe(
      "paused_human",
    );
    expect(deriveResumeOf(store([{ type: "fact.run_requeued_after_crash", payload: {} }]), "r")).toBe("crash");
    expect(deriveResumeOf(store([{ type: "fact.node_completed", payload: {} }]), "r")).toBe("fresh");
    expect(deriveResumeOf(store([]), "r")).toBe("fresh");
  });

  test("sleep resolves promptly when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await sleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("passField omits the key entirely at pass 0 and emits it above", () => {
    // Consumers distinguish pre-pass facts by key ABSENCE — a `pass: 0`
    // literal would break `'pass' in payload` checks and change fact bytes.
    expect("pass" in passField(0)).toBe(false);
    expect(passField(1)).toEqual({ pass: 1 });
  });

  test("mergeFanoutAppendOpts merges routingPatch key-wise (plan wins) and takes the max advanceAppliedTo", () => {
    // A shallow spread would REPLACE the fold's routingDelta wholesale while
    // advanceAppliedTo still committed — durably consuming the operator
    // intent without applying it.
    const merged = mergeFanoutAppendOpts(
      { routingPatch: { "budget_override.run.cost": 9, keep: "fold" }, advanceAppliedTo: 12 },
      { routingPatch: { keep: "plan", extra: 1 }, advanceAppliedTo: 7 },
    );
    expect(merged.routingPatch).toEqual({ "budget_override.run.cost": 9, keep: "plan", extra: 1 });
    expect(merged.advanceAppliedTo).toBe(12);
    // One-sided fields pass through untouched.
    expect(mergeFanoutAppendOpts({ advanceAppliedTo: 3 }, {})).toEqual({ advanceAppliedTo: 3 });
    expect(mergeFanoutAppendOpts({}, { routingPatch: { a: 1 } })).toEqual({ routingPatch: { a: 1 } });
  });

  test("composeAbortSignals: release() detaches source listeners without mutating signal state", () => {
    const src = new AbortController();
    const { signal, release } = composeAbortSignals([src.signal]);
    release();
    src.abort(new Error("late"));
    // Released composite no longer follows the source...
    expect(signal.aborted).toBe(false);

    // ...while an unreleased one does, forwarding the first source's reason.
    const src2 = new AbortController();
    const live = composeAbortSignals([src2.signal]);
    const reason = new Error("boom");
    src2.abort(reason);
    expect(live.signal.aborted).toBe(true);
    expect(live.signal.reason).toBe(reason);

    // An already-aborted source aborts the composite synchronously.
    const pre = new AbortController();
    pre.abort(new Error("pre"));
    expect(composeAbortSignals([pre.signal]).signal.aborted).toBe(true);
  });
});

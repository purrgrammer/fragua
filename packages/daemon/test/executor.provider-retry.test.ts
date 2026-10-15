// Provider auto-retry — end-to-end test through the executor.
//
// Registers a llm handler that returns `kind: "pause_provider"` with
// a configurable httpStatus, drives `runOne`, and asserts the daemon
// classified the failure correctly: 429/5xx → paused_auto with
// fact.run_paused{reason:"provider_retry"} + fact.provider_retry_attempted
// + auto_resume_at routing patch; 401/422 → paused (manual path,
// fact.run_paused with reason="provider_error"); chain past the cap →
// fact.run_halted with reason="provider_exhausted".

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

function registerPauseProviderNode(
  r: ReturnType<typeof rig>,
  nodeId: string,
  httpStatus: number | null,
  retryAfterMs?: number,
): void {
  r.dispatcher.register(r.workflowSha, nodeId, {
    kind: "llm",
    sideEffect: "external",
    maxMs: 100,
    handler: async () => ({
      kind: "pause_provider",
      httpStatus,
      provider: "stub",
      errorMessage: `injected pause_provider with httpStatus=${httpStatus}`,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    }),
  });
}

function startToImplement(r: ReturnType<typeof rig>, target: string): void {
  r.dispatcher.register(r.workflowSha, "start", {
    kind: "start",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: target, tokens: 0, costUsd: 0 }),
  });
  registerTerminalEcho(r.dispatcher, r.workflowSha, "done");
}

describe("provider auto-retry — pause classification", () => {
  test("429 → paused_auto with reason=provider_retry + retry-attempted fact + routing key", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n` });
    startToImplement(r, "impl");
    registerPauseProviderNode(r, "impl", 429);
    enqueue(r, "auto-429", "start");
    r.store.claimNextRun(1);

    await runOne("auto-429", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("auto-429");
    const pause = events.find((e) => e.type === "fact.run_paused");
    expect(pause).toBeDefined();
    const pp = pause!.payload as {
      reason: string;
      attempt?: number;
      resumeAt?: number;
      httpStatus: number | null;
    };
    expect(pp.reason).toBe("provider_retry");
    expect(pp.attempt).toBe(1);
    expect(pp.resumeAt).toBeGreaterThan(0);
    expect(pp.httpStatus).toBe(429);

    const attempted = events.filter((e) => e.type === "fact.provider_retry_attempted");
    expect(attempted.length).toBe(1);
    expect((attempted[0]!.payload as { attempt: number }).attempt).toBe(1);

    const state = r.store.getState("auto-429");
    expect(state?.status).toBe("paused_auto");
    expect(state?.routing["internal.auto_resume_at"]).toBeGreaterThan(0);
    expect(state?.routing["internal.provider_retry.attempt"]).toBe(1);
  });

  test("401 → paused with reason=provider_error (manual; no auto-retry)", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n` });
    startToImplement(r, "impl");
    registerPauseProviderNode(r, "impl", 401);
    enqueue(r, "manual-401", "start");
    r.store.claimNextRun(1);

    await runOne("manual-401", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("manual-401");
    const pause = events.find((e) => e.type === "fact.run_paused");
    expect(pause).toBeDefined();
    const pp = pause!.payload as { reason: string };
    expect(pp.reason).toBe("provider_error");

    const attempted = events.filter((e) => e.type === "fact.provider_retry_attempted");
    expect(attempted.length).toBe(0);

    expect(r.store.getState("manual-401")?.status).toBe("paused");
  });

  test("Retry-After header is honoured exactly in the resumeAt timestamp", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n` });
    startToImplement(r, "impl");
    registerPauseProviderNode(r, "impl", 429, 60_000);
    enqueue(r, "retry-after", "start");
    r.store.claimNextRun(1);

    const beforeMs = Date.now();
    await runOne("retry-after", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });

    const events = r.store.getEvents("retry-after");
    const pause = events.find((e) => e.type === "fact.run_paused")!;
    const resumeAt = (pause.payload as { resumeAt: number }).resumeAt;
    expect(resumeAt - beforeMs).toBeGreaterThanOrEqual(60_000);
    expect(resumeAt - beforeMs).toBeLessThan(60_500); // tight upper bound — provider's exact value
  });
});

describe("provider auto-retry — long provider Retry-After", () => {
  // The outcome the agent backend produces for pi-ai's
  // `Server requested 12311s retry delay (max: 60s). 429 {…rate_limit_error…}`
  // (pinned in packages/agent/test/sdk-retry-delay.test.ts).
  async function drive(r: ReturnType<typeof rig>, runId: string): Promise<void> {
    enqueue(r, runId, "start");
    r.store.claimNextRun(1);
    await runOne(runId, {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: new AbortController().signal,
    });
  }

  test("fidelity rate-limit shape (429 + retryAfterMs 12311000) → paused_auto at resumeAt; wake-pending requeues only once resumeAt passes", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n` });
    startToImplement(r, "impl");
    registerPauseProviderNode(r, "impl", 429, 12_311_000);
    const before = Date.now();
    await drive(r, "long-429");

    const pause = r.store.getEvents("long-429").find((e) => e.type === "fact.run_paused")!;
    const pp = pause.payload as { reason: string; resumeAt: number; retryAfterMs?: number; attempt: number };
    expect(pp.reason).toBe("provider_retry");
    expect(pp.retryAfterMs).toBe(12_311_000);
    expect(pp.attempt).toBe(1);
    expect(pp.resumeAt - before).toBeGreaterThanOrEqual(12_311_000);
    expect(pp.resumeAt - before).toBeLessThan(12_311_000 + 5_000);
    expect(r.store.getState("long-429")?.status).toBe("paused_auto");
    expect(r.store.getState("long-429")?.routing["internal.auto_resume_at"]).toBe(pp.resumeAt);

    const early = wakePending(r.store, () => pp.resumeAt - 1);
    expect(early.retryResumed).not.toContain("long-429");
    expect(r.store.getState("long-429")?.status).toBe("paused_auto");

    const due = wakePending(r.store, () => pp.resumeAt);
    expect(due.retryResumed).toContain("long-429");
    expect(r.store.getState("long-429")?.status).toBe("queued");
  });

  test("7h Retry-After → paused (provider_error) with cap detail, no retry-attempted fact", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n` });
    startToImplement(r, "impl");
    registerPauseProviderNode(r, "impl", 429, 7 * 60 * 60 * 1000);
    await drive(r, "long-7h");

    const events = r.store.getEvents("long-7h");
    const pause = events.find((e) => e.type === "fact.run_paused")!;
    const pp = pause.payload as { reason: string; detail?: string; retryAfterMs?: number };
    expect(pp.reason).toBe("provider_error");
    expect(pp.detail).toContain("7h");
    expect(pp.detail).toContain("6h");
    expect(pp.retryAfterMs).toBe(7 * 60 * 60 * 1000);
    expect(events.filter((e) => e.type === "fact.provider_retry_attempted")).toHaveLength(0);
    expect(r.store.getState("long-7h")?.status).toBe("paused");
  });
});

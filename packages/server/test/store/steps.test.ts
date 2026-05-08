// Unit tests for the eventsToSteps reducer.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@swarm/store";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations } from "../../src/store/steps.ts";

function ev(type: string, ts: number, payload: Record<string, unknown>): StoredEvent {
  return { runId: "r", seq: ts, type, writer: "daemon", payload, ts };
}

describe("eventsToSteps", () => {
  test("returns empty array when no llm.start events are present", () => {
    const events = [ev("fact.run_started", 1000, { startNode: "n1" })];
    expect(eventsToSteps(events)).toEqual([]);
  });

  test("one llm.start → one step with the wire-shape envelope", () => {
    const events = [
      ev("fact.node_started", 900_000, { nodeId: "n1" }),
      ev("llm.start", 1_000_000, {
        nodeId: "n1",
        iteration: { n: 1, max: 3 },
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
        fidelity: "compact",
        // Body fields below are intentionally ignored by the trimmed
        // reducer — the snapshot is for CostInspector only.
        prompt: "Do the thing",
        system_prompt: "You are a helpful assistant",
        thread_id: "dev",
        allowed_tools: ["bash"],
        denied_tools: [],
        messages: [{ role: "user", content: "hi" }],
        context_files: [],
      }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    const s = steps[0]!;
    expect(s.stepIdx).toBe(0);
    expect(s.nodeId).toBe("n1");
    expect(s.iteration).toEqual({ n: 1, max: 3 });
    expect(s.provider).toBe("openrouter");
    expect(s.model).toBe("anthropic/claude-haiku-4.5");
    expect(s.fidelity).toBe("compact");
    // `startedAt` anchors to fact.node_started.ts (truthful), not
    // llm.start.ts (pi-agent-core-buffered).
    expect(s.startedAt).toBe(new Date(900_000).toISOString());
    // Body fields should not appear on the snapshot at all.
    expect(s).not.toHaveProperty("prompt");
    expect(s).not.toHaveProperty("systemPrompt");
    expect(s).not.toHaveProperty("messages");
    expect(s).not.toHaveProperty("allowedTools");
    expect(s).not.toHaveProperty("threadId");
    expect(s).not.toHaveProperty("finalText");
  });

  test("startedAt anchors to fact.node_started.ts when present (pi-agent-core buffers llm.start)", () => {
    // pi-agent-core flushes llm.start at the end of the call, so its
    // ts trails the actual node start by tens of seconds. The reducer
    // must use fact.node_started.ts (daemon-written sync) instead.
    const events = [
      ev("fact.node_started", 1_000, { nodeId: "n1" }),
      ev("llm.start", 25_000, { nodeId: "n1" }), // 24s later — buffered
    ];
    const [s] = eventsToSteps(events);
    expect(s!.startedAt).toBe(new Date(1_000).toISOString());
  });

  test("startedAt falls back to llm.start.ts when no fact.node_started precedes it", () => {
    // Defensive: older runs / weird event orderings shouldn't crash.
    const events = [ev("llm.start", 5_000, { nodeId: "n1" })];
    const [s] = eventsToSteps(events);
    expect(s!.startedAt).toBe(new Date(5_000).toISOString());
  });

  test("loop iterations: first step uses fact.node_started, subsequent use llm.start.ts", () => {
    // We don't have a per-iteration fact event, so loop iterations 2+
    // fall back to the (buffered) llm.start.ts. Better than nothing —
    // and the simple non-loop case (the common one) is fully truthful.
    const events = [
      ev("fact.node_started", 900, { nodeId: "body" }),
      ev("llm.start", 1_000, { nodeId: "body", iteration: { n: 1, max: 3 } }),
      ev("llm.start", 2_000, { nodeId: "body", iteration: { n: 2, max: 3 } }),
      ev("llm.start", 3_000, { nodeId: "body", iteration: { n: 3, max: 3 } }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(3);
    expect(steps[0]!.startedAt).toBe(new Date(900).toISOString()); // fact.node_started
    expect(steps[1]!.startedAt).toBe(new Date(2_000).toISOString()); // llm.start
    expect(steps[2]!.startedAt).toBe(new Date(3_000).toISOString()); // llm.start
    expect(steps[0]!.iteration).toEqual({ n: 1, max: 3 });
    expect(steps[2]!.iteration).toEqual({ n: 3, max: 3 });
  });

  test("a fresh fact.node_started reopens the window — next llm.start anchors to its ts", () => {
    // After the first node window closes (next fact.node_started for
    // the same node), the loop-iteration fallback resets and the next
    // first-step in that window anchors to the new fact.node_started.
    const events = [
      ev("fact.node_started", 100, { nodeId: "n1" }),
      ev("llm.start", 200, { nodeId: "n1" }),
      ev("fact.node_completed", 300, { nodeId: "n1" }),
      // ... time passes, node re-runs (e.g. in a parent loop) ...
      ev("fact.node_started", 1_000, { nodeId: "n1" }),
      ev("llm.start", 1_500, { nodeId: "n1" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.startedAt).toBe(new Date(100).toISOString());
    expect(steps[1]!.startedAt).toBe(new Date(1_000).toISOString());
  });

  test("cost.recorded is NOT folded into the step (cost comes from SQL aggregates)", () => {
    const events = [
      ev("fact.node_started", 950, { nodeId: "n1" }),
      ev("llm.start", 1000, { nodeId: "n1" }),
      ev("cost.recorded", 1100, {
        nodeId: "n1",
        input_tokens: 100,
        output_tokens: 42,
        cost_usd: 0.003,
      }),
    ];
    const [s] = eventsToSteps(events);
    expect(s!.cost).toBeUndefined();
  });

  test("attachStepAggregates merges SQL-aggregated cost rows by startSeq", () => {
    const events = [
      { type: "fact.node_started", ts: 900, seq: 5, payload: { nodeId: "n1" } },
      { type: "llm.start", ts: 1000, seq: 10, payload: { nodeId: "n1" } },
      { type: "fact.node_started", ts: 1900, seq: 15, payload: { nodeId: "n2" } },
      { type: "llm.start", ts: 2000, seq: 20, payload: { nodeId: "n2" } },
    ];
    const baseSteps = eventsToSteps(events);
    expect(baseSteps[0]!.startSeq).toBe(10);
    expect(baseSteps[1]!.startSeq).toBe(20);

    const merged = attachStepAggregates(baseSteps, [
      {
        startSeq: 10,
        costUsd: 0.006,
        inputTokens: 50,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 0,
        billedTokens: 750,
        costEventCount: 2,
      },
      {
        startSeq: 20,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        billedTokens: 0,
        costEventCount: 0,
      },
    ]);
    expect(merged[0]!.cost).toEqual({
      input_tokens: 50,
      output_tokens: 200,
      billed_tokens: 750,
      cost_usd: 0.006,
      cache_read_tokens: 500,
      cache_write_tokens: 0,
    });
    // No cost events → no cost attached, even with a row present.
    expect(merged[1]!.cost).toBeUndefined();
  });

  test("branch step rows surface parentNodeId and parallelIndex from the preceding fact.node_started", () => {
    // Parallel handler emits per-branch fact.node_started with
    // parentNodeId / parallelIndex; llm.start itself does NOT carry
    // them. The reducer stamps the metadata onto the next llm.start
    // for that nodeId so the UI can group branch rows under their parent.
    const events = [
      ev("fact.node_started", 100, { nodeId: "fork", iteration: 1 }),
      ev("llm.start", 150, { nodeId: "fork" }),
      ev("fact.node_started", 200, { nodeId: "lensA", iteration: 1, parentNodeId: "fork", parallelIndex: 0 }),
      ev("llm.start", 250, { nodeId: "lensA" }),
      ev("fact.node_started", 300, { nodeId: "lensB", iteration: 1, parentNodeId: "fork", parallelIndex: 1 }),
      ev("llm.start", 350, { nodeId: "lensB" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(3);
    const fork = steps.find((s) => s.nodeId === "fork")!;
    const lensA = steps.find((s) => s.nodeId === "lensA")!;
    const lensB = steps.find((s) => s.nodeId === "lensB")!;
    expect(fork.parentNodeId).toBeUndefined();
    expect(fork.parallelIndex).toBeUndefined();
    expect(lensA.parentNodeId).toBe("fork");
    expect(lensA.parallelIndex).toBe(0);
    expect(lensB.parentNodeId).toBe("fork");
    expect(lensB.parallelIndex).toBe(1);
  });

  test("a top-level fact.node_started for a previously-branch nodeId clears stale branch metadata", () => {
    // Defensive: if a node id reappears as top-level (e.g. workflow
    // edited mid-replay), the next llm.start must NOT inherit the old
    // branch attribution.
    const events = [
      ev("fact.node_started", 100, { nodeId: "x", iteration: 1, parentNodeId: "p", parallelIndex: 0 }),
      ev("llm.start", 150, { nodeId: "x" }),
      ev("fact.node_started", 1000, { nodeId: "x", iteration: 1 }),
      ev("llm.start", 1050, { nodeId: "x" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.parentNodeId).toBe("p");
    expect(steps[1]!.parentNodeId).toBeUndefined();
  });

  test("a node paused then resumed coalesces into a single step (cost breakdown unifies pause/resume halves)", () => {
    // Wire shape on the Run detail Cost breakdown for a paused+resumed
    // node: the daemon emits fact.node_started → llm.start, then on
    // operator pause writes fact.run_paused, and on resume re-dispatches
    // the same node with a second fact.node_started → llm.start. Today
    // eventsToSteps opens a separate step for each llm.start, so the UI
    // shows two rows for what is conceptually one node activation.
    //
    // Expected: one step per node window, regardless of how many
    // pause/resume cycles intervene. Both llm.start startSeqs are
    // exposed on the surviving step so attachStepAggregates can fold
    // every cost.recorded row from either half into the single row.
    const events = [
      ev("fact.node_started", 1_000, { nodeId: "n1" }),
      { type: "llm.start", ts: 1_500, seq: 10, payload: { nodeId: "n1" } },
      ev("fact.run_paused", 2_000, { reason: "operator", nodeId: "n1" }),
      ev("fact.run_resumed", 5_000, { fromStatus: "paused" }),
      ev("fact.node_started", 5_100, { nodeId: "n1" }),
      { type: "llm.start", ts: 5_500, seq: 42, payload: { nodeId: "n1" } },
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    const s = steps[0]!;
    expect(s.nodeId).toBe("n1");
    // startedAt anchors to the FIRST fact.node_started — the node
    // really started at 1_000; the resume just unblocked it.
    expect(s.startedAt).toBe(new Date(1_000).toISOString());
  });

  test("sub-agent step rows derive a wall duration from subagent.start/end timestamps (not from buffered llm.start neighbours)", () => {
    // Reproduces the Cost-tab '0ms' bug for sub-agent rows. Wire shape
    // when a parent codergen step spawns a sub-agent (see
    // `packages/daemon/src/spawn-subagent.ts` + the `__subagent:<uuid>`
    // synthetic nodeId in `eventsToSteps`):
    //
    //   fact.node_started{nodeId:"p1"}                ts=    900  (truthful)
    //   llm.start       {nodeId:"p1"}                  ts=  9_950  (pi-agent-core buffered: flushed at end of parent's first turn)
    //   subagent.start  {subagent_id:"abc", parent_node_id:"p1"}  ts=  1_000  (truthful — daemon parentEmit, sync)
    //   llm.start       {nodeId:"__subagent:abc"}      ts=  9_900  (buffered: flushed when sub-agent's call ends)
    //   subagent.end    {subagent_id:"abc", status:"completed"}  ts=  9_000  (truthful — daemon parentEmit, sync, after child returns)
    //   llm.start       {nodeId:"p1"}                  ts= 10_050  (buffered: parent's second turn flush)
    //
    // The sub-agent ran from ts=1_000 → 9_000 wall-clock — 8 seconds.
    // Today `eventsToSteps` anchors the sub-agent row's `startedAt` to
    // its (buffered) `llm.start.ts`, and `fillOrphanDurations` derives
    // the end from the next step's (also-buffered) `llm.start.ts`. Both
    // come from the same flush window, so the delta collapses to a
    // handful of ms — '0ms' in the UI. The fix anchors `startedAt` to
    // the matching `subagent.start.ts` and stamps `durationMs` from
    // `subagent.end.ts - subagent.start.ts` (both truthful), threaded
    // through the same `durationMs` field codergen rows already use so
    // the existing CostInspector renders it.
    const events: StoredEvent[] = [
      ev("fact.node_started", 900, { nodeId: "p1" }),
      { runId: "r", seq: 1, type: "llm.start", writer: "daemon", payload: { nodeId: "p1" }, ts: 9_950 },
      ev("subagent.start", 1_000, {
        subagent_id: "abc",
        parent_node_id: "p1",
        iteration: 1,
        provider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
        name: "reviewer",
      }),
      {
        runId: "r",
        seq: 2,
        type: "llm.start",
        writer: "daemon",
        payload: { nodeId: "__subagent:abc", subagent_id: "abc" },
        ts: 9_900,
      },
      ev("subagent.end", 9_000, {
        subagent_id: "abc",
        status: "completed",
        summary_chars: 42,
        total_tool_calls: 1,
      }),
      { runId: "r", seq: 3, type: "llm.start", writer: "daemon", payload: { nodeId: "p1" }, ts: 10_050 },
    ];
    const steps = eventsToSteps(events);
    const filled = fillOrphanDurations(steps, { lastEventTs: 11_000, runIsTerminal: true });
    const subStep = filled.find((s) => s.nodeId === "__subagent:abc");
    expect(subStep).toBeDefined();
    expect(subStep!.subagentId).toBe("abc");
    // Wall duration should be the truthful subagent.end − subagent.start
    // = 9_000 − 1_000 = 8_000ms. Anything ≪ this (the buggy near-zero
    // delta from buffered `llm.start` neighbours) means the sub-agent
    // row is still showing '0ms' in the Cost tab.
    expect(subStep!.durationMs).toBe(8_000);
  });

  test("sub-agent steps carry parentStartSeq so a goal_gate retarget can group them per parent invocation", () => {
    // When `review` REJECTs and the runtime retargets back to `audit`,
    // the same parentNodeId opens a fresh step for the second invocation.
    // Sub-agents spawned in each invocation must key off their parent's
    // `startSeq` (not just `parentNodeId`) so the Cost-tab consumer
    // doesn't pool them under one row. This test pins the producer
    // half — the consumer half lives in CostInspector.test.tsx.
    const events: StoredEvent[] = [
      // First invocation of `audit` (startSeq 10), one sub-agent `s1`.
      ev("fact.node_started", 1_000, { nodeId: "audit" }),
      { runId: "r", seq: 10, type: "llm.start", writer: "daemon", payload: { nodeId: "audit" }, ts: 1_100 },
      ev("subagent.start", 1_200, {
        subagent_id: "s1",
        parent_node_id: "audit",
        iteration: 0,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        name: "store",
      }),
      {
        runId: "r",
        seq: 11,
        type: "llm.start",
        writer: "daemon",
        payload: { nodeId: "__subagent:s1", subagent_id: "s1" },
        ts: 1_300,
      },
      ev("subagent.end", 2_000, { subagent_id: "s1", status: "completed", summary_chars: 1, total_tool_calls: 0 }),
      ev("fact.node_completed", 2_500, { nodeId: "audit" }),
      // Goal-gate retarget: `audit` re-opens (startSeq 20), sub-agent `s2`.
      ev("fact.node_started", 3_000, { nodeId: "audit" }),
      { runId: "r", seq: 20, type: "llm.start", writer: "daemon", payload: { nodeId: "audit" }, ts: 3_100 },
      ev("subagent.start", 3_200, {
        subagent_id: "s2",
        parent_node_id: "audit",
        iteration: 0,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        name: "store",
      }),
      {
        runId: "r",
        seq: 21,
        type: "llm.start",
        writer: "daemon",
        payload: { nodeId: "__subagent:s2", subagent_id: "s2" },
        ts: 3_300,
      },
      ev("subagent.end", 4_000, { subagent_id: "s2", status: "completed", summary_chars: 1, total_tool_calls: 0 }),
    ];
    const steps = eventsToSteps(events);
    const sub1 = steps.find((s) => s.subagentId === "s1");
    const sub2 = steps.find((s) => s.subagentId === "s2");
    expect(sub1?.parentNodeId).toBe("audit");
    expect(sub2?.parentNodeId).toBe("audit");
    // The whole point: the two sub-agents share parentNodeId but must
    // NOT share parentStartSeq — that's what unblocks per-invocation
    // grouping in the Cost tab.
    expect(sub1?.parentStartSeq).toBe(10);
    expect(sub2?.parentStartSeq).toBe(20);
  });

  // Tool nodes (parallelogram in DOT) never open an `llm.start`. Without
  // synthesis they're invisible in the Cost breakdown — for parallel
  // sections that mix codergen + tool branches the tool branches just
  // disappear from the panel.
  test("emits a synthetic step for a tool node — no llm.start, just fact.node_started + completed", () => {
    const events: StoredEvent[] = [
      ev("fact.node_started", 1_000, { nodeId: "plugin_validate", iteration: 0 }),
      ev("tool.execution_start", 1_010, { nodeId: "plugin_validate" }),
      ev("tool.completed", 1_500, { nodeId: "plugin_validate", exitCode: 0 }),
      ev("fact.node_completed", 1_520, { nodeId: "plugin_validate", iteration: 0, outcomeStatus: "success" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    const tool = steps[0];
    expect(tool?.nodeId).toBe("plugin_validate");
    expect(tool?.startedAt).toBe(new Date(1_000).toISOString());
    expect(tool?.durationMs).toBe(520);
    expect(tool?.cost).toBeUndefined(); // no LLM call → no aggregate
    expect(tool?.provider).toBeUndefined();
    expect(tool?.model).toBeUndefined();
  });

  test("tool-node synthesis carries parentNodeId + parallelIndex when the tool ran as a parallel branch", () => {
    const events: StoredEvent[] = [
      ev("fact.node_started", 1_000, { nodeId: "fanout", iteration: 0 }),
      ev("fact.node_started", 1_100, {
        nodeId: "plugin_validate",
        iteration: 0,
        parentNodeId: "fanout",
        parallelIndex: 0,
      }),
      ev("fact.node_completed", 1_500, { nodeId: "plugin_validate", iteration: 0, outcomeStatus: "success" }),
    ];
    const steps = eventsToSteps(events);
    const tool = steps.find((s) => s.nodeId === "plugin_validate");
    expect(tool).toBeDefined();
    expect(tool?.parentNodeId).toBe("fanout");
    expect(tool?.parallelIndex).toBe(0);
    expect(tool?.durationMs).toBe(400);
  });

  test("a codergen node (with llm.start) does NOT also produce a tool-node step at completion", () => {
    // Defensive: an llm.start arrives between fact.node_started and
    // fact.node_completed for the same nodeId. Only one step should
    // emit — the LLM-anchored one. The pending-tool entry must clear.
    const events: StoredEvent[] = [
      ev("fact.node_started", 1_000, { nodeId: "drift", iteration: 0 }),
      ev("llm.start", 1_100, { nodeId: "drift", provider: "ppq", model: "gpt-5.4" }),
      ev("fact.node_completed", 2_000, { nodeId: "drift", iteration: 0, outcomeStatus: "success" }),
    ];
    const steps = eventsToSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.provider).toBe("ppq"); // the LLM-anchored row, not a tool stub
  });

  test("attachStepAggregates leaves steps untouched when no aggregate matches their startSeq", () => {
    const events = [{ type: "llm.start", ts: 1000, seq: 99, payload: { nodeId: "n1" } }];
    const baseSteps = eventsToSteps(events);
    const merged = attachStepAggregates(baseSteps, []);
    expect(merged[0]!.cost).toBeUndefined();
    expect(merged[0]!.startSeq).toBe(99);
  });
});

describe("fillOrphanDurations", () => {
  test("each step's duration = next step's startedAt − this step's startedAt", () => {
    // The full picture: step starts anchor to fact.node_started (truthful),
    // and end at the next step's start. That gives wall-clock node duration.
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }), // buffered ts — ignored for startedAt
      ev("fact.node_started", 4_500, { nodeId: "b" }),
      ev("llm.start", 5_000, { nodeId: "b" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 6_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(3_500); // 4500 − 1000
    expect(filled[1]!.durationMs).toBe(1_500); // 6000 − 4500 (last step on terminal)
  });

  test("last step on a terminal run → duration = lastEventTs − startedAt", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: true });
    expect(filled[0]!.durationMs).toBe(8_000); // 9000 − 1000
  });

  test("last step on a LIVE run keeps durationMs undefined (client ticks)", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const filled = fillOrphanDurations(steps, { lastEventTs: 9_000, runIsTerminal: false });
    expect(filled[0]!.durationMs).toBeUndefined();
  });

  test("returns new objects — does not mutate the input array", () => {
    const steps = eventsToSteps([
      ev("fact.node_started", 1_000, { nodeId: "a" }),
      ev("llm.start", 1_500, { nodeId: "a" }),
    ]);
    const before = steps[0]!;
    const filled = fillOrphanDurations(steps, { lastEventTs: 5_000, runIsTerminal: true });
    expect(before.durationMs).toBeUndefined();
    expect(filled[0]).not.toBe(before);
    expect(filled[0]!.durationMs).toBe(4_000); // 5000 − 1000
  });
});

// Unit tests for the eventsToSteps reducer.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@fragua/store";
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
    // The summary field is undefined when no per-node summary= is set.
    expect(s.summary).toBeUndefined();
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

  // Tool nodes (tool type) never open an `llm.start`. Without
  // synthesis they're invisible in the Cost breakdown — tool nodes
  // would just disappear from the panel.
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

  test("a llm node (with llm.start) does NOT also produce a tool-node step at completion", () => {
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

  test("fact.fanout_started tags each branch step with its parallel parent (parentNodeId)", () => {
    // scope (linear) → review (parallel: lens_a, lens_b) → synth (linear).
    // The branch llm.starts interleave; each must carry parentNodeId="review",
    // while scope/synth carry none — so the Cost breakdown can nest branches.
    const events = [
      ev("fact.node_started", 1000, { nodeId: "scope" }),
      ev("llm.start", 1100, { nodeId: "scope", seq: 1 }),
      ev("fact.node_completed", 1200, { nodeId: "scope" }),
      ev("fact.fanout_started", 1300, { nodeId: "review", iteration: 0, branches: ["lens_a", "lens_b"] }),
      ev("fact.dispatch_started", 1310, { nodeId: "lens_a" }),
      ev("fact.dispatch_started", 1320, { nodeId: "lens_b" }),
      ev("llm.start", 1400, { nodeId: "lens_a", seq: 2 }),
      ev("llm.start", 1410, { nodeId: "lens_b", seq: 3 }),
      ev("fact.fanout_joined", 1900, { nodeId: "review", iteration: 0, nextNode: "synth", branchesCompleted: 2 }),
      ev("fact.node_started", 2000, { nodeId: "synth" }),
      ev("llm.start", 2100, { nodeId: "synth", seq: 4 }),
    ].map((e, i) => ({ ...e, seq: (e.payload as { seq?: number }).seq ?? i }));

    const steps = eventsToSteps(events);
    const byNode = new Map(steps.map((s) => [s.nodeId, s]));
    expect(byNode.get("lens_a")?.parentNodeId).toBe("review");
    expect(byNode.get("lens_b")?.parentNodeId).toBe("review");
    expect(byNode.get("scope")?.parentNodeId).toBeUndefined();
    expect(byNode.get("synth")?.parentNodeId).toBeUndefined();
  });

  test("a fan-out branch step's duration is its truthful node_completed, not the barrier-wait gap", () => {
    // lens_b finishes fast but the join waits on the slow lens_a, so synth
    // (post-barrier) starts long after — the flat-next-step heuristic would bill
    // lens_b that whole wait. Its true duration is its start → node_completed.
    const events = [
      ev("fact.fanout_started", 1000, { nodeId: "review", iteration: 0, branches: ["lens_a", "lens_b"] }),
      ev("llm.start", 1010, { nodeId: "lens_a", seq: 1 }),
      ev("llm.start", 1010, { nodeId: "lens_b", seq: 2 }),
      ev("fact.node_completed", 1100, { nodeId: "lens_b", iteration: 0, outcomeStatus: "success" }), // fast: 100ms
      ev("fact.node_completed", 60_000, { nodeId: "lens_a", iteration: 0, outcomeStatus: "success" }), // slow: 59s
      ev("fact.fanout_joined", 60_100, { nodeId: "review", iteration: 0, nextNode: "synth", branchesCompleted: 2 }),
      ev("llm.start", 60_200, { nodeId: "synth", seq: 3 }),
      ev("fact.node_completed", 61_000, { nodeId: "synth", iteration: 0 }),
    ].map((e, i) => ({ ...e, seq: (e.payload as { seq?: number }).seq ?? i }));

    const steps = fillOrphanDurations(eventsToSteps(events), { lastEventTs: 61_000, runIsTerminal: true });
    const byNode = new Map(steps.map((s) => [s.nodeId, s]));
    // lens_b: truthful 100ms (start 1000 → node_completed 1100), NOT the ~59s gap
    // to synth's start that the flat heuristic would assign.
    expect(byNode.get("lens_b")?.durationMs).toBe(100);
    // lens_a (the slow branch): truthful 59s.
    expect(byNode.get("lens_a")?.durationMs).toBe(59_000);
  });

  test("a RUNNING multi-turn branch leaves every step's durationMs undefined (so the Cost row ticks)", () => {
    // A multi-LLM-turn entry branch (correctness_scan) is mid-flight: 2 llm.starts,
    // NO fact.node_completed yet, while a sibling branch's step starts after it.
    // fillOrphanDurations must NOT bill the branch's non-frontier turn the gap to
    // its sibling's start — a concurrent branch has no temporal "next step", so a
    // running branch's turns stay undefined and the merged Cost row ticks live.
    const events = [
      ev("fact.fanout_started", 1000, { nodeId: "review_lenses", iteration: 0, branches: ["scan_a", "scan_b"] }),
      ev("fact.dispatch_started", 1010, { nodeId: "scan_a" }),
      ev("fact.dispatch_started", 1020, { nodeId: "scan_b" }),
      ev("llm.start", 1100, { nodeId: "scan_a", seq: 1 }), // scan_a turn 1
      ev("llm.start", 1200, { nodeId: "scan_a", seq: 2 }), // scan_a turn 2 (still running)
      ev("llm.start", 1300, { nodeId: "scan_b", seq: 3 }), // sibling — its start is NOT scan_a's "end"
    ].map((e, i) => ({ ...e, seq: (e.payload as { seq?: number }).seq ?? i }));

    // Live run: no node_completed for either branch yet.
    const steps = fillOrphanDurations(eventsToSteps(events), { lastEventTs: 1300, runIsTerminal: false });
    const scanASteps = steps.filter((s) => s.nodeId === "scan_a");
    expect(scanASteps).toHaveLength(2);
    // BOTH turns of the running branch stay undefined — neither the gap to scan_a's
    // own next turn nor the gap to the sibling scan_b is a truthful end.
    expect(scanASteps.every((s) => s.durationMs === undefined)).toBe(true);
    // Each branch step still nests under the parallel parent.
    expect(scanASteps.every((s) => s.parentNodeId === "review_lenses")).toBe(true);
  });

  test("a COMPLETED multi-turn branch surfaces the truthful full span on its last step", () => {
    // Same branch, now finished: 2 llm.starts + a fact.node_completed. The truthful
    // span (fanout_started → node_completed) lands on the branch's LAST step, which
    // collapseTurns surfaces as the merged row's duration. Don't regress this.
    const events = [
      ev("fact.fanout_started", 1000, { nodeId: "review_lenses", iteration: 0, branches: ["scan_a", "scan_b"] }),
      ev("fact.dispatch_started", 1010, { nodeId: "scan_a" }),
      ev("llm.start", 1100, { nodeId: "scan_a", seq: 1 }),
      ev("llm.start", 1200, { nodeId: "scan_a", seq: 2 }),
      ev("fact.node_completed", 9_000, { nodeId: "scan_a", iteration: 0, outcomeStatus: "success" }),
    ].map((e, i) => ({ ...e, seq: (e.payload as { seq?: number }).seq ?? i }));

    const steps = fillOrphanDurations(eventsToSteps(events), { lastEventTs: 9_000, runIsTerminal: false });
    const scanASteps = steps.filter((s) => s.nodeId === "scan_a");
    expect(scanASteps).toHaveLength(2);
    // First turn carries no per-step duration; the truthful end lands on the last
    // step. node_completed stamps `completed.ts − last-step.startedAt` on the last
    // step (anchored to its own buffered llm.start.ts = 1200): 9000 − 1200 = 7800.
    expect(scanASteps[0]?.durationMs).toBeUndefined();
    expect(scanASteps[1]?.durationMs).toBe(7_800);
    // The first turn anchors to the truthful dispatch_started ts (1010) — the
    // branch's real start. collapseTurns reconstructs the full merged span from
    // it: 1200 + 7800 − 1010 = 7990ms, not the frozen-while-running zero.
    expect(Date.parse(scanASteps[0]!.startedAt)).toBe(1010);
  });

  test("an ABORTED branch stamps a finite duration on its last step (no forever-ticking)", () => {
    // A branch that aborted (pause / shutdown / abort-loop) must show a STATIC
    // elapsed time, not tick `now - startedAt` forever. node_aborted stamps the
    // truthful duration just like node_completed; without it the parentNodeId
    // guard in fillOrphanDurations leaves the step undefined → live-ticking
    // despite being terminated.
    const events = [
      ev("fact.fanout_started", 1000, { nodeId: "review_lenses", iteration: 0, branches: ["scan_a", "scan_b"] }),
      ev("fact.dispatch_started", 1010, { nodeId: "scan_a" }),
      ev("llm.start", 1100, { nodeId: "scan_a", seq: 1 }),
      ev("llm.start", 1200, { nodeId: "scan_a", seq: 2 }),
      ev("fact.node_aborted", 5_000, { nodeId: "scan_a", iteration: 0, cause: "aborted" }),
    ].map((e, i) => ({ ...e, seq: (e.payload as { seq?: number }).seq ?? i }));

    const steps = fillOrphanDurations(eventsToSteps(events), { lastEventTs: 5_000, runIsTerminal: false });
    const scanASteps = steps.filter((s) => s.nodeId === "scan_a");
    expect(scanASteps).toHaveLength(2);
    // Static duration on the last step (5000 − 1200 = 3800), NOT undefined.
    expect(scanASteps[1]?.durationMs).toBe(3_800);
    expect(scanASteps[0]?.parentNodeId).toBe("review_lenses");
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

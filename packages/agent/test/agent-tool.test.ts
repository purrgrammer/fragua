// `agent` tool (orchestrator-workers): worker synthesis, synthetic-node-id
// persistence, cost routed through the caller's emit, and outputs enforcement.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { agentSyntheticNodeId, type EventType, type NodeAttrs } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend, WorkerSlots, WorkerSlotsAborted } from "../src/backend.ts";
import { advertisedTools } from "./context-tools.ts";

interface PersistedRow {
  message: AgentMessage;
  nodeId: string | undefined;
}

interface RunResult {
  events: Array<{ type: EventType; data: Record<string, unknown> }>;
  rows: PersistedRow[];
  contexts: Context[];
  outcome: { status: string; costUsd?: number };
}

function coreRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

/** Drive one caller `llm` turn whose responses are served in order across the
 * caller AND worker agents (they share the faux queue). */
async function runCaller(opts: {
  scratch: string;
  attrs: NodeAttrs;
  responses: AssistantMessage[];
}): Promise<RunResult> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    const contexts: Context[] = [];
    faux.setResponses(
      opts.responses.map((msg) => (ctx: Context) => {
        contexts.push(structuredClone(ctx));
        return msg;
      }),
    );
    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiLlmBackend({
      registry: coreRegistry(),
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: [],
    });
    const events: RunResult["events"] = [];
    const rows: PersistedRow[] = [];
    const outcome = (await backend.run({
      node: { id: "n1", type: "llm", attrs: opts.attrs },
      prompt: "orchestrate",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-agent-tool",
      workflow_sha: "sha",
      iteration: { n: 0, max: 0 },
      emit: async (type, data) => {
        events.push({ type, data });
      },
      persistMessage: (message, persistOpts) => {
        rows.push({ message, nodeId: persistOpts?.nodeId });
      },
    })) as RunResult["outcome"];
    return { events, rows, contexts, outcome };
  } finally {
    faux.unregister();
  }
}

const CALLER_ATTRS: NodeAttrs = { allowed_tools: ["read", "bash", "agent"] };

describe("agent tool — worker transcript persistence", () => {
  test("worker rows carry the synthetic node id; caller rows do not", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-agent-tool-"));
    try {
      const { rows } = await runCaller({
        scratch,
        attrs: CALLER_ATTRS,
        responses: [
          fauxAssistantMessage([fauxToolCall("agent", { task: "read the file" }, { id: "toolu_w1" })], {
            stopReason: "toolUse",
          }),
          // worker's single turn
          fauxAssistantMessage([fauxText("worker did the work")], { stopReason: "stop" }),
          // caller's final turn
          fauxAssistantMessage([fauxText("all integrated")], { stopReason: "stop" }),
        ],
      });
      const workerNodeId = agentSyntheticNodeId("n1", { n: 0 }, "toolu_w1");
      const workerRows = rows.filter((r) => r.nodeId === workerNodeId);
      // the worker's own assistant turn persists under the synthetic id
      const workerAssistant = workerRows.filter((r) => r.message.role === "assistant");
      expect(workerAssistant.length).toBeGreaterThan(0);
      expect(JSON.stringify(workerAssistant)).toContain("worker did the work");
      expect(workerRows.every((r) => r.nodeId === workerNodeId)).toBe(true);
      // the worker's own conversational turns never land on the caller's node —
      // only the tool RESULT (which legitimately echoes the worker's answer) does.
      const callerConversation = rows.filter(
        (r) => r.nodeId === undefined && (r.message.role === "assistant" || r.message.role === "user"),
      );
      expect(JSON.stringify(callerConversation)).not.toContain("worker did the work");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("worker cost.recorded routes through the caller's emit (the node bucket)", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-agent-cost-"));
    try {
      const { events } = await runCaller({
        scratch,
        attrs: CALLER_ATTRS,
        responses: [
          fauxAssistantMessage([fauxToolCall("agent", { task: "do it" }, { id: "toolu_w1" })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage([fauxText("worker done")], { stopReason: "stop" }),
          fauxAssistantMessage([fauxText("caller done")], { stopReason: "stop" }),
        ],
      });
      // 2 caller assistant turns + 1 worker assistant turn = 3 cost.recorded.
      // If the worker's cost bypassed the caller's emit, only 2 would arrive.
      const costEvents = events.filter((e) => e.type === "cost.recorded");
      expect(costEvents).toHaveLength(3);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("agent tool — worker toolset clamping", () => {
  test("the worker cannot call agent (depth 1) or route", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-agent-depth-"));
    try {
      const { contexts } = await runCaller({
        scratch,
        attrs: CALLER_ATTRS,
        responses: [
          fauxAssistantMessage([fauxToolCall("agent", { task: "recurse?" }, { id: "toolu_w1" })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage([fauxText("worker done")], { stopReason: "stop" }),
          fauxAssistantMessage([fauxText("caller done")], { stopReason: "stop" }),
        ],
      });
      // contexts[1] is the worker's first model request.
      const workerTools = advertisedTools(contexts[1]!).map((t) => t.name);
      expect(workerTools).not.toContain("agent");
      expect(workerTools).not.toContain("route");
      expect(workerTools).toContain("read");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("agent tool — declared outputs enforcement", () => {
  test("a worker that never emits the declared struct returns status error", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-agent-outputs-"));
    try {
      const { rows } = await runCaller({
        scratch,
        attrs: CALLER_ATTRS,
        responses: [
          fauxAssistantMessage(
            [fauxToolCall("agent", { task: "produce", outputs: { done: { type: "boolean" } } }, { id: "toolu_w1" })],
            { stopReason: "toolUse" },
          ),
          // worker turn 1: prose, no emit_output
          fauxAssistantMessage([fauxText("I finished but forgot to emit")], { stopReason: "stop" }),
          // worker turn 2 (corrective re-prompt): still no emit_output
          fauxAssistantMessage([fauxText("still no emit")], { stopReason: "stop" }),
          // caller's final turn
          fauxAssistantMessage([fauxText("worker failed, moving on")], { stopReason: "stop" }),
        ],
      });
      // The agent tool result is persisted as the caller's toolResult row (no
      // synthetic node id). Its text carries the error the worker returned.
      const toolResults = rows.filter((r) => r.nodeId === undefined && r.message.role === "toolResult");
      const text = JSON.stringify(toolResults);
      expect(text).toContain("did not call emit_output");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("agent tool — worker concurrency slots", () => {
  test("WorkerSlots admits `limit` workers and queues the rest until a release", async () => {
    const slots = new WorkerSlots(2);
    const r1 = await slots.acquire();
    const r2 = await slots.acquire();
    let third = false;
    const p3 = slots.acquire().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
    // releasing twice is a no-op, so a double-release can't over-admit
    r3();
    const r4 = await slots.acquire();
    const r5 = await slots.acquire();
    let sixth = false;
    void slots.acquire().then(() => {
      sixth = true;
    });
    await Promise.resolve();
    expect(sixth).toBe(false);
    r4();
    r5();
  });

  test("a queued worker gives up with WorkerSlotsAborted when the caller's signal fires", async () => {
    const slots = new WorkerSlots(1);
    const release = await slots.acquire();
    const ac = new AbortController();
    const waiting = slots.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(WorkerSlotsAborted);
    release();
    // the aborted waiter must not have been granted the freed slot
    const next = await slots.acquire();
    next();
  });
});

describe("agent tool — worker step events", () => {
  test("a worker opens its own llm.start and closes with agent.worker_end under its synthetic node id", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-agent-steps-"));
    try {
      const workerNodeId = agentSyntheticNodeId("n1", { n: 0 }, "call_steps");
      const { events } = await runCaller({
        scratch,
        attrs: CALLER_ATTRS,
        responses: [
          fauxAssistantMessage([
            fauxToolCall("agent", { task: "say hi", allowed_tools: ["read"] }, { id: "call_steps" }),
          ]),
          fauxAssistantMessage([fauxText("hi from the worker")]),
          fauxAssistantMessage([fauxText("done")]),
        ],
      });
      const workerStarts = events.filter((e) => e.type === "llm.start" && e.data["nodeId"] === workerNodeId);
      expect(workerStarts).toHaveLength(1);
      expect(workerStarts[0]?.data["worker_of"]).toBe("n1");
      expect(workerStarts[0]?.data["worker_id"]).toBe("call_steps");
      const ends = events.filter((e) => e.type === "agent.worker_end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.data["nodeId"]).toBe(workerNodeId);
      expect(ends[0]?.data["status"]).toBe("completed");
      const workerCost = events.filter((e) => e.type === "cost.recorded" && e.data["nodeId"] === workerNodeId);
      expect(workerCost.length).toBeGreaterThan(0);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

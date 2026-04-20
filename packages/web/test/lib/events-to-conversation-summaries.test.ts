// Tests for the graph-level summary reducer branches:
//   - tool.completed       → section.toolSummary
//   - parallel.completed   → section.parallelSummary
//   - fan_in.completed     → section.fanInSummary
//
// The main conversation reducer suite in events-to-conversation.test.ts
// covers LLM-driven sections; these tests focus on non-LLM handler
// payloads so the UI renders a usable summary even when the node
// produces no agent turn.

import { describe, expect, it } from "bun:test";
import { eventsToConversation, type RawEvent } from "../../src/lib/events-to-conversation.ts";

function ev(type: string, data: Record<string, unknown>, node_id?: string): RawEvent {
  const out: RawEvent = { type, data };
  if (node_id !== undefined) out.node_id = node_id;
  return out;
}

describe("events-to-conversation — graph-level summaries", () => {
  it("tool.completed populates toolSummary on the section", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "lint" }, "lint"),
      ev(
        "tool.completed",
        {
          command: "bun run lint",
          exitCode: 0,
          durationMs: 1234,
          stdoutBytes: 42,
          stderrBytes: 0,
        },
        "lint",
      ),
      ev("node.completed", { node_id: "lint", data: { outcome: "pass" } }, "lint"),
    ]);
    const section = out.find((s) => s.nodeId === "lint");
    expect(section?.toolSummary).toEqual({
      command: "bun run lint",
      exitCode: 0,
      durationMs: 1234,
      stdoutBytes: 42,
      stderrBytes: 0,
    });
  });

  it("tool.completed with non-zero exit carries the exit code forward", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "test" }, "test"),
      ev("tool.completed", { command: "false", exitCode: 1, durationMs: 10, stdoutBytes: 0, stderrBytes: 5 }, "test"),
    ]);
    expect(out.find((s) => s.nodeId === "test")?.toolSummary?.exitCode).toBe(1);
  });

  it("parallel.completed records joinPolicy + branch statuses", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "fork" }, "fork"),
      ev(
        "parallel.completed",
        {
          parallelNodeId: "fork",
          joinPolicy: "wait_all",
          branches: [
            { branchId: "a", status: "success" },
            { branchId: "b", status: "fail" },
          ],
        },
        "fork",
      ),
    ]);
    const section = out.find((s) => s.nodeId === "fork");
    expect(section?.parallelSummary?.joinPolicy).toBe("wait_all");
    expect(section?.parallelSummary?.branches).toEqual([
      { branchId: "a", status: "success" },
      { branchId: "b", status: "fail" },
    ]);
  });

  it("parallel.completed with unknown joinPolicy defaults to wait_all", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "fork" }, "fork"),
      ev("parallel.completed", { parallelNodeId: "fork", branches: [] }, "fork"),
    ]);
    expect(out.find((s) => s.nodeId === "fork")?.parallelSummary?.joinPolicy).toBe("wait_all");
  });

  it("fan_in.completed records winner, allFailed, and rankedOrder", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "pick" }, "pick"),
      ev(
        "fan_in.completed",
        {
          fanInNodeId: "pick",
          parallelNodeId: "fork",
          winner: "a",
          allFailed: false,
          rankedOrder: ["a", "c", "b"],
        },
        "pick",
      ),
    ]);
    const section = out.find((s) => s.nodeId === "pick");
    expect(section?.fanInSummary).toEqual({
      winner: "a",
      allFailed: false,
      rankedOrder: ["a", "c", "b"],
    });
  });

  it("fan_in.completed with allFailed=true is surfaced", () => {
    const out = eventsToConversation([
      ev("node.started", { node_id: "pick" }, "pick"),
      ev("fan_in.completed", { winner: null, allFailed: true, rankedOrder: ["x"] }, "pick"),
    ]);
    const section = out.find((s) => s.nodeId === "pick");
    expect(section?.fanInSummary?.allFailed).toBe(true);
    expect(section?.fanInSummary?.winner).toBeNull();
  });

  it("summary events without node_id are ignored (no crash)", () => {
    const out = eventsToConversation([
      ev("tool.completed", { command: "x", exitCode: 0, durationMs: 0, stdoutBytes: 0, stderrBytes: 0 }),
      ev("parallel.completed", { branches: [] }),
      ev("fan_in.completed", { winner: null, allFailed: false, rankedOrder: [] }),
    ]);
    expect(out).toEqual([]);
  });
});

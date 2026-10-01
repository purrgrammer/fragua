import type { JsonObject, ToolResultMessage } from "@fragua/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { RunMessageRow } from "@/lib/api";
import { type AgentToolData, AgentToolResult } from "./AgentToolResult.tsx";

function result(data: AgentToolData, isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "toolu_1",
    toolName: "agent",
    content: [{ type: "text", text: data.text ?? "" }],
    details: {
      fragua_tool: "agent",
      is_error: isError,
      data: data as unknown as JsonObject,
      truncated: false,
      original_length: 0,
    },
    isError,
    timestamp: 0,
  };
}

function workerRow(ordinal: number, text: string): RunMessageRow {
  return {
    ordinal,
    nodeId: "__agent.implement#0/toolu_1",
    iteration: 0,
    content: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "x",
      provider: "p",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    } as RunMessageRow["content"],
  };
}

const renderRow = (row: RunMessageRow) => (
  <div key={row.ordinal} data-testid={`worker-row-${row.ordinal}`}>
    {JSON.stringify(row.content)}
  </div>
);

afterEach(cleanup);

describe("AgentToolResult", () => {
  test("shows status, meta, task, outputs and the collapsed transcript count", () => {
    render(
      <AgentToolResult
        params={{ task: "In packages/store: add the column", model: "claude-sonnet-4-6" }}
        result={result({
          status: "completed",
          text: "done",
          cost_usd: 0.83,
          turns: 14,
          tool_calls: 31,
          outputs: { tests_pass: true },
        })}
        workerRows={[workerRow(10, "reading"), workerRow(11, "writing")]}
        renderRow={renderRow}
      />,
    );
    expect(screen.getByTestId("agent-tool-status").textContent).toContain("worker completed");
    expect(screen.getByText(/14 turns · 31 tool calls · \$0.8300/)).toBeTruthy();
    expect(screen.getByTestId("agent-tool-task").textContent).toContain("In packages/store: add the column");
    expect(screen.getByTestId("agent-tool-outputs").textContent).toContain('"tests_pass": true');
    expect(screen.getByTestId("agent-tool-transcript-count").textContent).toContain("2 messages");
    expect(screen.queryByTestId("worker-row-10")).toBeNull();

    fireEvent.click(screen.getByText("transcript"));
    expect(screen.getByTestId("worker-row-10")).toBeTruthy();
    expect(screen.getByTestId("worker-row-11")).toBeTruthy();
  });

  test("renders a running worker while the result is pending", () => {
    render(<AgentToolResult params={{ task: "x" }} result={undefined} workerRows={[]} renderRow={renderRow} />);
    expect(screen.getByTestId("agent-tool-status").textContent).toContain("worker running");
    expect(screen.getByTestId("agent-tool-transcript-count").textContent).toContain("waiting for the first message");
  });

  test("labels a cap status and surfaces the reason text", () => {
    render(
      <AgentToolResult
        params={{ task: "x" }}
        result={result({ status: "max_cost", text: "worker stopped: per-worker cost cap reached ($1.5000)" }, true)}
        workerRows={[]}
        renderRow={renderRow}
      />,
    );
    expect(screen.getByTestId("agent-tool-status").textContent).toContain("worker cost cap reached");
    expect(screen.getByTestId("agent-tool-text").textContent).toContain("cost cap reached");
  });
});

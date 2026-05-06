// RunConversation — tool_node row rendering.
//
// A graph-level tool node (parallelogram shape) is persisted as a
// `role:"tool_node"` row carrying the command, cwd, exit code, and
// tail-truncated stdout/stderr. RunConversation renders it as a
// Terminal card inside the tool node's NodeSection.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function toolNodeRow(opts: {
  ordinal: number;
  nodeId: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  durationMs?: number;
  stdoutTruncated?: boolean;
  outputArtifactKey?: string;
}): RunMessageRow {
  return {
    ordinal: opts.ordinal,
    nodeId: opts.nodeId,
    content: {
      role: "tool_node",
      command: opts.command,
      cwd: opts.cwd,
      exitCode: opts.exitCode,
      durationMs: opts.durationMs ?? 42,
      stdout: opts.stdout,
      stderr: opts.stderr ?? "",
      ...(opts.stdoutTruncated ? { stdoutTruncated: true as const } : {}),
      ...(opts.outputArtifactKey ? { outputArtifactKey: opts.outputArtifactKey } : {}),
      timestamp: 0,
    },
  };
}

describe("RunConversation — tool_node row", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders a Terminal card with command, exit code, and stdout for a successful tool node", () => {
    const messages: RunMessageRow[] = [
      toolNodeRow({
        ordinal: 1,
        nodeId: "find_pr",
        command: "gh pr list --head l10n_crowdin",
        cwd: "/Users/dev/frontend",
        exitCode: 0,
        stdout: "1234\n",
      }),
    ];
    const nodeStates: NodeState[] = [{ nodeId: "find_pr", iteration: 0, state: "completed", lastEventSeq: 1 }];

    const { container } = renderWithClient(<RunConversation messages={messages} nodeStates={nodeStates} />);
    const q = within(container);

    // Section exists for the tool node.
    expect(q.getByTestId("node-section-find_pr")).toBeTruthy();
    // Terminal renders.
    const terminal = q.getByTestId("terminal");
    expect(terminal).toBeTruthy();
    // The full command shows in the title.
    expect(terminal.textContent).toContain("$ gh pr list --head l10n_crowdin");
    // Exit code in the status line.
    expect(terminal.textContent).toContain("exit 0");
    // Stdout body.
    expect(terminal.textContent).toContain("1234");
    // cwd surfaced under the terminal so operators can answer "where did this run?".
    expect(container.textContent).toContain("/Users/dev/frontend");
  });

  it("renders both stdout and stderr when both are present", () => {
    const messages: RunMessageRow[] = [
      toolNodeRow({
        ordinal: 1,
        nodeId: "tests",
        command: "bun test",
        cwd: "/repo",
        exitCode: 1,
        stdout: "1 pass\n",
        stderr: "1 fail: foo.test.ts\n",
      }),
    ];
    const { container } = renderWithClient(<RunConversation messages={messages} />);
    const terminal = within(container).getByTestId("terminal");
    expect(terminal.textContent).toContain("1 pass");
    expect(terminal.textContent).toContain("1 fail");
    expect(terminal.textContent).toContain("exit 1");
  });

  it("indicates truncation and surfaces the artifact key for spilled output", () => {
    const messages: RunMessageRow[] = [
      toolNodeRow({
        ordinal: 1,
        nodeId: "build",
        command: "bun run build",
        cwd: "/repo",
        exitCode: 0,
        stdout: "compiled 12 files\n",
        stdoutTruncated: true,
        outputArtifactKey: "build:stdout",
      }),
    ];
    const { container } = renderWithClient(<RunConversation messages={messages} />);
    const text = within(container).getByTestId("terminal").textContent ?? "";
    expect(text).toContain("stdout truncated");
    expect(text).toContain("build:stdout");
  });
});

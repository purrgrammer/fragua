// RunConversation — tool_node row rendering.
//
// A graph-level tool node (tool type) is persisted as a
// `role:"tool_node"` row carrying the command, cwd, exit code, and
// tail-truncated stdout/stderr. RunConversation renders it as a
// CodeBlock (shell) + Terminal card inside the tool node's NodeSection.

import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

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
    iteration: 0,
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
  afterEach(() => cleanup());

  it("renders a CodeBlock for the command and a Terminal for the output, no cwd row, no terminal title", () => {
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

    expect(q.getByTestId("node-section-find_pr")).toBeTruthy();

    // CodeBlock renders with shell language attribute.
    const codeBlock = container.querySelector('[data-language="shell"]');
    expect(codeBlock).toBeTruthy();

    // Command text is visible inside the code block.
    expect(codeBlock?.textContent).toContain("gh pr list --head l10n_crowdin");

    // Node name appears in the CodeBlock header.
    expect(codeBlock?.textContent).toContain("find_pr");

    // Terminal renders the body with exit-code status, no `$ <cmd>` title.
    const terminal = q.getByTestId("terminal");
    expect(terminal.textContent).toContain("exit 0");
    expect(terminal.textContent).toContain("1234");
    expect(terminal.textContent ?? "").not.toContain("$ gh pr list");

    // cwd is no longer rendered under the terminal.
    expect(container.textContent ?? "").not.toContain("/Users/dev/frontend");
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

  it("renders a streaming Terminal for an in-flight tool node (no persisted message yet)", () => {
    const toolStreams = new Map<string, { stdout: string; stderr: string }>([
      ["find_pr", { stdout: "fetching PRs…\n", stderr: "" }],
    ]);
    const nodeStates: NodeState[] = [{ nodeId: "find_pr", iteration: 0, state: "running", lastEventSeq: 1 }];
    const { container } = renderWithClient(
      <RunConversation messages={[]} nodeStates={nodeStates} toolStreams={toolStreams} isLive />,
    );
    // Synthesized streaming section + streaming row exists.
    expect(within(container).getByTestId("node-section-find_pr")).toBeTruthy();
    expect(within(container).getByTestId("tool-stream-find_pr")).toBeTruthy();
    // Streaming output is visible.
    const terminal = within(container).getByTestId("terminal");
    expect(terminal.textContent).toContain("fetching PRs");
    // Status reads "running" with the thinking pulse.
    expect(terminal.textContent).toContain("running");
  });

  it("the streaming row goes away once the persisted tool_node message lands for that node", () => {
    const toolStreams = new Map<string, { stdout: string; stderr: string }>([
      ["find_pr", { stdout: "fetching PRs…\n", stderr: "" }],
    ]);
    const messages: RunMessageRow[] = [
      toolNodeRow({
        ordinal: 1,
        nodeId: "find_pr",
        command: "gh pr list",
        cwd: "/repo",
        exitCode: 0,
        stdout: "fetching PRs…\n1234\n",
      }),
    ];
    const { container } = renderWithClient(<RunConversation messages={messages} toolStreams={toolStreams} />);
    // No synthesized stream-only row when the persisted message exists.
    expect(within(container).queryByTestId("tool-stream-find_pr")).toBeNull();
    // The persisted command is inside a shell CodeBlock (no snippet input).
    const codeBlock = container.querySelector('[data-language="shell"]');
    expect(codeBlock).toBeTruthy();
    expect(codeBlock?.textContent).toContain("gh pr list");
    expect(container.querySelector('[data-slot="snippet-input"]')).toBeNull();
  });

  it("shows the node name in the CodeBlock header for multi-line shell commands", () => {
    const multiLineCommand = "set -e\nbun install\nbun test";
    const messages: RunMessageRow[] = [
      toolNodeRow({
        ordinal: 1,
        nodeId: "ci_gate",
        command: multiLineCommand,
        cwd: "/repo",
        exitCode: 0,
        stdout: "All tests pass\n",
      }),
    ];
    const { container } = renderWithClient(<RunConversation messages={messages} />);

    const codeBlock = container.querySelector('[data-language="shell"]');
    expect(codeBlock).toBeTruthy();

    // Every line of the multi-line script is rendered (not collapsed).
    expect(codeBlock?.textContent).toContain("set -e");
    expect(codeBlock?.textContent).toContain("bun install");
    expect(codeBlock?.textContent).toContain("bun test");

    // Node name appears in the header.
    expect(codeBlock?.textContent).toContain("ci_gate");
  });
});

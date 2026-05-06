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

  it("renders a Snippet for the command and a Terminal for the output, no cwd row, no terminal title", () => {
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
    // Snippet carries the command (read from the readonly input value).
    const snippet = container.querySelector('[data-slot="snippet"]');
    expect(snippet).toBeTruthy();
    const snippetInput = snippet?.querySelector('[data-slot="snippet-input"]') as HTMLInputElement | null;
    expect(snippetInput?.value).toBe("gh pr list --head l10n_crowdin");

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
    // The persisted Terminal (with Snippet) is the only one rendered.
    const snippetInput = container.querySelector('[data-slot="snippet-input"]') as HTMLInputElement | null;
    expect(snippetInput?.value).toBe("gh pr list");
  });
});

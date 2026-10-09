// RunConversation — substituted output values inside a prompt.
//
// A prompt that read `${{ outputs.X.f }}` carries the value inside
// `<fragua_output_<sha256>>…</fragua_output_<sha256>>` boundary tags. The
// user row renders each such value as a labelled block naming the producing
// step and field (matched by hashing the run's emitted structs the same way),
// pretty-printed when it is JSON, and never shows the tag text.

import { outputValueId, renderOutputValue } from "@fragua/core";
import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

const picks = [{ title: "Kill the cookie banner", url: "https://killthecookiebanner.eu/" }];
const picksRendered = renderOutputValue(picks);
const picksId = outputValueId(picksRendered);
const prId = outputValueId("139");

const messages: RunMessageRow[] = [
  {
    ordinal: 1,
    nodeId: "find_pr",
    iteration: 0,
    content: {
      role: "tool_node",
      command: "gh pr view",
      cwd: "/r",
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      outputs: { pr: "139" },
      timestamp: 0,
    },
  },
  {
    ordinal: 2,
    nodeId: "shortlist",
    iteration: 0,
    content: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "emit_output", arguments: { picks } }],
      timestamp: 0,
    } as unknown as RunMessageRow["content"],
  },
  {
    ordinal: 3,
    nodeId: "read",
    iteration: 0,
    content: {
      role: "user",
      content: `Fetch each of these for PR <fragua_output_${prId}>139</fragua_output_${prId}>:\n\n<fragua_output_${picksId}>${picksRendered}</fragua_output_${picksId}>\n\nTwo takeaways each.`,
      timestamp: 0,
    } as unknown as RunMessageRow["content"],
  },
];

const nodeStates: NodeState[] = [
  { nodeId: "find_pr", iteration: 0, state: "completed", lastEventSeq: 1, pass: 0 },
  { nodeId: "shortlist", iteration: 0, state: "completed", lastEventSeq: 2, pass: 0 },
  { nodeId: "read", iteration: 0, state: "completed", lastEventSeq: 3, pass: 0 },
];

describe("RunConversation — substituted output values", () => {
  afterEach(() => cleanup());

  it("labels each value with its producer, pretty-prints JSON, and hides the tags", () => {
    const { container } = renderWithClient(<RunConversation messages={messages} nodeStates={nodeStates} />);
    const q = within(container);
    const row = q.getByTestId("message-3");

    const outputs = row.querySelectorAll("[data-producer]");
    expect(outputs.length).toBe(2);
    const scalar = outputs[0] as HTMLElement;
    expect(scalar.getAttribute("data-producer")).toBe("outputs · find_pr.pr");
    expect(scalar.textContent).toContain("139");

    const list = outputs[1] as HTMLElement;
    expect(list.getAttribute("data-producer")).toBe("outputs · shortlist.picks");
    expect(list.textContent).toContain("outputs · shortlist.picks");
    expect(list.textContent).toContain('"title"');

    expect(row.textContent).not.toContain("fragua_output");
    expect(row.textContent).toContain("Two takeaways each.");
  });

  it("labels a value no producer emitted as an input", () => {
    const task = "rename foo to bar";
    const only: RunMessageRow[] = [
      {
        ordinal: 1,
        nodeId: "plan",
        iteration: 0,
        content: {
          role: "user",
          content: `Plan <fragua_output_${outputValueId(task)}>${task}</fragua_output_${outputValueId(task)}>.`,
          timestamp: 0,
        } as unknown as RunMessageRow["content"],
      },
    ];
    const { container } = renderWithClient(
      <RunConversation
        messages={only}
        nodeStates={[{ nodeId: "plan", iteration: 0, state: "completed", lastEventSeq: 1, pass: 0 }]}
      />,
    );
    const block = within(container).getByTestId("message-1-output-5");
    expect(block.getAttribute("data-producer")).toBe("input");
    expect(block.textContent).toContain(task);
  });
});

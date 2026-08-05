// RunConversation — output-envelope tags never reach the operator.
//
// `${{ outputs.X.f }}` interpolation wraps each value in
// `<fragua_output_<sha256>>…</fragua_output_<sha256>>` before the prompt is
// sent. Those bytes belong on the event log; the conversation view renders
// through Streamdown, which escapes raw HTML instead of parsing it, so without
// stripping the operator reads 64 hex characters around every value.

import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunConversation } from "../../src/components/RunConversation.tsx";
import type { NodeState, RunMessageRow } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";

const ID = "3f".repeat(32);

function userRow(text: string): RunMessageRow {
  return {
    ordinal: 1,
    nodeId: "scan",
    iteration: 0,
    content: { role: "user", content: text, timestamp: 0 },
  } as unknown as RunMessageRow;
}

const nodeStates: NodeState[] = [{ nodeId: "scan", iteration: 0, state: "completed", lastEventSeq: 1 }];

describe("RunConversation — output envelopes", () => {
  afterEach(() => cleanup());

  it("renders the wrapped value without its boundary tags", () => {
    const messages = [userRow(`Review this diff_spec: <fragua_output_${ID}>origin/main..HEAD</fragua_output_${ID}>`)];

    const { container } = renderWithClient(<RunConversation messages={messages} nodeStates={nodeStates} />);
    const text = within(container).getByTestId("message-1").textContent ?? "";

    expect(text).toContain("origin/main..HEAD");
    expect(text).not.toContain("fragua_output");
    // Guard the specific failure mode: Streamdown escaping the tag rather than
    // dropping it, which is what put the raw digest on screen.
    expect(text).not.toContain(ID);
  });
});

// deriveDetail: raw DOT source passthrough on `pipeline.started`.
//
// The server does not parse DOT (that lives in @swarm/core's parser and
// runs in the browser). We only test that the `workflow_source` event
// field is copied through verbatim as `PipelineDetail.workflowSource`.

import { describe, expect, test } from "bun:test";
import { deriveDetail } from "../src/index.ts";
import { ev } from "./helpers.ts";

describe("deriveDetail — workflowSource", () => {
  test("is undefined when pipeline.started lacks workflow_source", () => {
    const events = [
      ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z", data: { workflow: "w.dot" } }),
      ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:01.000Z" }),
    ];
    const detail = deriveDetail("r1", events);
    expect(detail.workflowSource).toBeUndefined();
  });

  test("copies the DOT source through unchanged when present", () => {
    const source = `digraph g {
      start [shape=Mdiamond]
      a -> b
      b -> c
    }`;
    const events = [
      ev({
        type: "pipeline.started",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { workflow: "w.dot", workflow_source: source },
      }),
    ];
    const detail = deriveDetail("r1", events);
    expect(detail.workflowSource).toBe(source);
  });

  test("ignores a non-string / empty workflow_source field", () => {
    const events = [
      ev({
        type: "pipeline.started",
        timestamp: "2024-01-01T00:00:00.000Z",
        data: { workflow: "w.dot", workflow_source: "" },
      }),
    ];
    const detail = deriveDetail("r1", events);
    expect(detail.workflowSource).toBeUndefined();
  });
});

// Contract tests for the exported TypeBox schemas and the port shape. These
// guard the public API: once @swarm/web imports `PipelineSummary` etc., any
// breaking change shows up here first.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  ErrorBody,
  InterviewAnswer,
  InterviewQuestion,
  NodeState,
  PipelineDetail,
  PipelineSummary,
} from "../src/schemas.ts";

describe("schemas", () => {
  test("PipelineSummary accepts a minimal row and rejects bad status", () => {
    const ok = {
      runId: "r1",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      eventCount: 3,
    };
    expect(Value.Check(PipelineSummary, ok)).toBe(true);

    const bad = { ...ok, status: "bogus" };
    expect(Value.Check(PipelineSummary, bad)).toBe(false);
  });

  test("PipelineDetail validates node states", () => {
    const detail = {
      runId: "r1",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "success",
      lastEventSeq: 5,
      nodes: [{ nodeId: "a", state: "completed", lastEventSeq: 5 }],
    };
    expect(Value.Check(PipelineDetail, detail)).toBe(true);

    const badNode = { ...detail, nodes: [{ nodeId: "a", state: "frozen", lastEventSeq: 1 }] };
    expect(Value.Check(PipelineDetail, badNode)).toBe(false);
  });

  test("NodeState rejects non-integer seq", () => {
    expect(Value.Check(NodeState, { nodeId: "a", state: "pending", lastEventSeq: 1 })).toBe(true);
    expect(Value.Check(NodeState, { nodeId: "a", state: "pending", lastEventSeq: 1.5 })).toBe(false);
  });

  test("InterviewQuestion accepts all four question types", () => {
    for (const type of ["YES_NO", "MULTIPLE_CHOICE", "FREEFORM", "CONFIRMATION"] as const) {
      expect(
        Value.Check(InterviewQuestion, {
          questionId: "q1",
          nodeId: "n1",
          text: "?",
          type,
          stage: "review",
          askedAt: "2024-01-01T00:00:00.000Z",
        }),
      ).toBe(true);
    }
  });

  test("InterviewAnswer rejects empty value", () => {
    expect(Value.Check(InterviewAnswer, { value: "YES" })).toBe(true);
    expect(Value.Check(InterviewAnswer, { value: "" })).toBe(false);
    expect(Value.Check(InterviewAnswer, {})).toBe(false);
  });

  test("ErrorBody: error message is required, code/details optional", () => {
    expect(Value.Check(ErrorBody, { error: "boom" })).toBe(true);
    expect(Value.Check(ErrorBody, { error: "boom", code: "bad_request" })).toBe(true);
    expect(Value.Check(ErrorBody, { code: "bad_request" })).toBe(false);
  });
});

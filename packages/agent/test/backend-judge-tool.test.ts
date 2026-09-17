// PiLlmBackend — the `judge` tool is present exactly when the run carries a
// judge client. Same harness as backend-skill-tool: drive a real run against
// the faux provider, script a `judge` tool call, and read the
// `tool.execution_end` envelope.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import type { EventType, JudgeClient, JudgeRequest } from "@fragua/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "../src/backend.ts";

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function stubJudge(requests: JudgeRequest[]): JudgeClient {
  return {
    provider: "typesafe",
    async ask(req) {
      requests.push(req);
      return {
        model: "jev-1.13.0",
        answers: { holds: { type: "noul", noul: 0.88 } },
        usage: { input_tokens: 120, output_tokens: 10 },
        costUsd: 120 * (0.042 / 1_000_000),
      };
    },
  };
}

async function runOnce(scratch: string, judge: JudgeClient | undefined): Promise<CapturedEvent[]> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "judge",
            {
              state: { claim: "x", evidence: "y" },
              questions: { holds: { type: "noul", instructions: "Does `evidence` support `claim`?" } },
            },
            { id: "tc1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: scratch });
    const backend = new PiLlmBackend({
      registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: [],
    });
    const events: CapturedEvent[] = [];
    await backend.run({
      node: { id: "n1", type: "llm", attrs: {} },
      prompt: "judge it",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-judge-tool",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
      ...(judge !== undefined ? { judge } : {}),
    });
    return events;
  } finally {
    faux.unregister();
  }
}

describe("PiLlmBackend judge tool wiring", () => {
  test("with a judge client the call resolves through the tool and records its cost", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-tool-"));
    try {
      const requests: JudgeRequest[] = [];
      const events = await runOnce(scratch, stubJudge(requests));
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "judge");
      expect(ends).toHaveLength(1);
      const result = ends[0]!.data["result"] as { isError?: boolean; details?: { data?: { model?: string } } };
      expect(result.isError).toBeFalsy();
      expect(result.details?.data?.model).toBe("jev-1.13.0");
      expect(requests).toHaveLength(1);
      // the judge call's spend rides the node's cost stream
      const judgeCost = events.filter((e) => e.type === "cost.recorded" && e.data["provider"] === "typesafe");
      expect(judgeCost).toHaveLength(1);
      expect(judgeCost[0]!.data["input_tokens"]).toBe(120);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("without a judge client the tool is stripped — the scripted call is an unknown tool", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-tool-"));
    try {
      const events = await runOnce(scratch, undefined);
      // pi-agent-core synthesises a "Tool judge not found" error envelope for a
      // scripted call to a tool absent from the agent's list — the signal the
      // backend stripped it.
      const end = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "judge");
      expect(end).toBeDefined();
      expect(end!.data["is_error"]).toBe(true);
      const result = end!.data["result"] as { content?: Array<{ type: string; text?: string }> } | undefined;
      expect((result?.content ?? []).some((b) => typeof b.text === "string" && b.text.includes("not found"))).toBe(
        true,
      );
      expect(events.some((e) => e.type === "cost.recorded" && e.data["provider"] === "typesafe")).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// `judge` tool — wire-level execute() against a stub judge client. Pins the
// question validation, the cost.recorded emission, and the error surfaces.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@fragua/core";
import { type JudgeClient, JudgeProviderError, type JudgeRequest } from "@fragua/core/handler";
import { judgeTool } from "../src/judge-tool.ts";
import type { FraguaToolContext } from "../src/types.ts";

const env = {} as unknown as ExecutionEnvironment;

function ctxWith(
  judge: JudgeClient | undefined,
  emitted: Array<{ type: string; payload: Record<string, unknown> }> = [],
): FraguaToolContext {
  return {
    runId: "r",
    nodeId: "n",
    iteration: 0,
    http: {} as never,
    emit: (type: string, payload: Record<string, unknown>) => {
      emitted.push({ type, payload });
    },
    ...(judge !== undefined ? { judge } : {}),
  } as unknown as FraguaToolContext;
}

function stubJudge(requests: JudgeRequest[]): JudgeClient {
  return {
    provider: "typesafe",
    async ask(req) {
      requests.push(req);
      return {
        model: "jev-1.13.0",
        answers: {
          c1: { type: "noul", noul: 0.91 },
          c2: { type: "noul", noul: 0.12 },
        },
        usage: { input_tokens: 800, output_tokens: 20 },
        costUsd: 800 * (0.042 / 1_000_000),
      };
    },
  };
}

const QUESTIONS = {
  c1: { type: "noul", instructions: "Does `evidence.c1` support `claims.c1`?" },
  c2: { type: "noul", instructions: "Does `evidence.c2` support `claims.c2`?" },
};

describe("judge tool", () => {
  test("asks the client with the parsed questions, returns the answers, emits cost.recorded", async () => {
    const requests: JudgeRequest[] = [];
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const out = await judgeTool.execute(
      { state: { claims: { c1: "x", c2: "y" }, evidence: { c1: "…", c2: "…" } }, questions: QUESTIONS },
      env,
      { fraguaContext: ctxWith(stubJudge(requests), emitted) },
    );
    expect(out.is_error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("jev-1.13.0");
    expect(Object.keys(requests[0]!.questions)).toEqual(["c1", "c2"]);
    expect(out.data?.answers).toEqual({ c1: { type: "noul", noul: 0.91 }, c2: { type: "noul", noul: 0.12 } });
    expect(out.data?.input_tokens).toBe(800);
    expect(out.text).toContain('"noul": 0.91');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.type).toBe("cost.recorded");
    expect(emitted[0]!.payload["input_tokens"]).toBe(800);
    expect(emitted[0]!.payload["model"]).toBe("jev-1.13.0");
  });

  test("malformed questions are a tool error the model can correct, not a throw", async () => {
    const out = await judgeTool.execute(
      { state: "x", questions: { q: { type: "choice", instructions: "pick", criteria: ["a", "b"] } } },
      env,
      { fraguaContext: ctxWith(stubJudge([])) },
    );
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/invalid questions/);
    expect(out.text).toMatch(/mapping of ≥ 2 option ids/);
  });

  test("no judge client on the context → a clear error", async () => {
    const out = await judgeTool.execute({ state: "x", questions: QUESTIONS }, env, {
      fraguaContext: ctxWith(undefined),
    });
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/no judge provider is credentialed/);
  });

  test("a 400 from the provider explains the input cap", async () => {
    const failing: JudgeClient = {
      provider: "typesafe",
      async ask() {
        throw new JudgeProviderError("max_tokens_exceeded", "typesafe", 400);
      },
    };
    const out = await judgeTool.execute({ state: "x", questions: QUESTIONS }, env, { fraguaContext: ctxWith(failing) });
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/\(400\)/);
    expect(out.text).toMatch(/smaller excerpt/);
  });

  test("non-JSON state (a function) is rejected before any call", async () => {
    const requests: JudgeRequest[] = [];
    const out = await judgeTool.execute({ state: { f: () => 1 } as unknown, questions: QUESTIONS }, env, {
      fraguaContext: ctxWith(stubJudge(requests)),
    });
    expect(out.is_error).toBe(true);
    expect(requests).toHaveLength(0);
  });
});

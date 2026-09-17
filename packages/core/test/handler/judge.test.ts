import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@fragua/types";
import { makeJudgeHandler } from "../../src/handler/handlers/judge.ts";
import type { HandlerContext, ToolRegistry } from "../../src/handler/types.ts";
import type { ExecutionEnvironment } from "../../src/types/execution.ts";
import {
  JUDGE_USD_PER_INPUT_TOKEN,
  type JudgeAnswer,
  type JudgeClient,
  JudgeNotCredentialedError,
  JudgeProviderError,
  type JudgeQuestion,
  type JudgeRequest,
} from "../../src/types/judge.ts";

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

interface Captured {
  messages: AgentMessage[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  requests: JudgeRequest[];
}

function stubJudge(
  answers: Record<string, JudgeAnswer> | ((req: JudgeRequest) => Record<string, JudgeAnswer>),
  captured: Captured,
  usage = { input_tokens: 500, output_tokens: 70 },
): JudgeClient {
  return {
    provider: "typesafe",
    async ask(req) {
      captured.requests.push(req);
      return { model: "jev-1.13.0", answers: typeof answers === "function" ? answers(req) : answers, usage };
    },
  };
}

function throwingJudge(err: unknown): JudgeClient {
  return {
    provider: "typesafe",
    async ask() {
      throw err;
    },
  };
}

function stubEnv(files: Record<string, string>): ExecutionEnvironment {
  return {
    cwd: () => "/wt",
    projectCwd: () => "/wt",
    readFile: async (p: string) => {
      const f = files[p];
      if (f === undefined) throw new Error(`ENOENT: ${p}`);
      return f;
    },
    writeFile: async () => {},
    exists: async (p: string) => p in files,
    listDir: async () => [],
    glob: async () => [],
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
  } as unknown as ExecutionEnvironment;
}

function stubCtx(captured: Captured, overrides: Partial<HandlerContext> = {}): HandlerContext {
  const base: HandlerContext = {
    runId: "r",
    nodeId: "j",
    iteration: 0,
    signal: new AbortController().signal,
    routing: {},
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: emptyRegistry,
    messages: {
      append: (m) => {
        captured.messages.push(m);
        return { ordinal: captured.messages.length };
      },
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: () => ({ runId: "r", nodeId: "j", iteration: 0, key: "", sha256: "", sizeBytes: 0, mime: null }),
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: {},
    emit: (type, payload) => {
      captured.events.push({ type, payload });
    },
  };
  return { ...base, ...overrides };
}

const SIZE: JudgeQuestion = {
  type: "choice",
  instructions: "Size it.",
  criteria: { skip: "trivial", quick: "small", full: "large" },
};
const OK: JudgeQuestion = { type: "noul", instructions: "ok?" };
const DEPTH: JudgeQuestion = { type: "score", instructions: "deep?", criteria: ["shallow", "adequate", "thorough"] };

const sizeAnswer = (choice: string, confidence: number): JudgeAnswer => ({
  type: "choice",
  choice,
  confidence,
  probabilities: {
    skip: choice === "skip" ? 0.8 : 0.1,
    quick: choice === "quick" ? 0.8 : 0.1,
    full: choice === "full" ? 0.8 : 0.1,
  },
});

function fresh(): Captured {
  return { messages: [], events: [], requests: [] };
}

describe("judge handler — happy paths", () => {
  test("pure producer: derived outputs for choice / score / noul, cost from input tokens", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: { diff: "${{ inputs.diff }}", focus: "literal" },
      questions: { size: SIZE, ok: OK, depth: DEPTH },
    });
    expect(spec.kind).toBe("judge");
    expect(spec.sideEffect).toBe("idempotent");
    const judge = stubJudge(
      {
        size: sizeAnswer("quick", 0.9),
        ok: { type: "noul", noul: 0.18 },
        depth: {
          type: "score",
          score: 1.2,
          confidence: 0.7,
          legend: { "0": "shallow", "1": "adequate", "2": "thorough" },
          probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
        },
      },
      cap,
    );
    const result = await spec.handler(stubCtx(cap, { judge, args: { inputs: { diff: "+1 -1" } } }));
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") return;
    expect(result.route).toBeUndefined();
    expect(result.outcomeStatus).toBeUndefined();
    expect(result.outputs).toEqual({
      size: { choice: "quick", confidence: 0.9, probabilities: { skip: 0.1, quick: 0.8, full: 0.1 } },
      ok: { noul: 0.18 },
      depth: { score: 1.2, level: 1, confidence: 0.7, probabilities: [0.1, 0.6, 0.3] },
    });
    expect(result.modelName).toBe("jev-1.13.0");
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(70);
    expect(result.tokens).toBe(570);
    expect(result.costUsd).toBeCloseTo(500 * JUDGE_USD_PER_INPUT_TOKEN, 12);
    expect(result.outputCostUsd).toBe(0);

    expect(cap.requests[0]!.model).toBe("jev-latest");
    expect(cap.requests[0]!.state).toEqual({ diff: "+1 -1", focus: "literal" });
    expect(cap.requests[0]!.questions).toEqual({ size: SIZE, ok: OK, depth: DEPTH });

    const types = cap.events.map((e) => e.type);
    expect(types).toEqual(["judge.requested", "judge.answered", "cost.recorded"]);
    const cost = cap.events[2]!.payload;
    expect(cost["input_tokens"]).toBe(500);
    expect(cost["cost_output_usd"]).toBe(0);
    expect(cost["model"]).toBe("jev-1.13.0");

    expect(cap.messages).toHaveLength(1);
    const msg = cap.messages[0]!;
    expect(msg.role).toBe("judge_node");
    if (msg.role === "judge_node") {
      expect(msg.model).toBe("jev-1.13.0");
      expect(Object.keys(msg.questions)).toEqual(["size", "ok", "depth"]);
      expect(msg.decision).toBeUndefined();
    }
  });

  test("decide.route: the chosen option becomes the route", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: "x",
      questions: { size: SIZE },
      decide: { route: { question: "size", min_confidence: 0.6, below: "unsure" } },
    });
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge({ size: sizeAnswer("full", 0.95) }, cap) }));
    expect(result.kind).toBe("transition");
    if (result.kind !== "transition") return;
    expect(result.route).toBe("full");
    expect(result.outcomeStatus).toBeUndefined();
    const msg = cap.messages[0]!;
    if (msg.role === "judge_node")
      expect(msg.decision).toEqual({ kind: "route", route: "full", belowThreshold: false });
  });

  test("decide.route: below min-confidence takes the `below` landing", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: "x",
      questions: { size: SIZE },
      decide: { route: { question: "size", min_confidence: 0.6, below: "unsure" } },
    });
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge({ size: sizeAnswer("full", 0.41) }, cap) }));
    if (result.kind !== "transition") throw new Error(result.kind);
    expect(result.route).toBe("unsure");
    expect((result.outputs as Record<string, Record<string, unknown>>)["size"]!["choice"]).toBe("full");
    const msg = cap.messages[0]!;
    if (msg.role === "judge_node")
      expect(msg.decision).toEqual({ kind: "route", route: "unsure", belowThreshold: true });
  });

  test("decide.route without a floor always takes the choice", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: "x",
      questions: { size: SIZE },
      decide: { route: { question: "size" } },
    });
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge({ size: sizeAnswer("skip", 0.34) }, cap) }));
    if (result.kind !== "transition") throw new Error(result.kind);
    expect(result.route).toBe("skip");
  });

  test("decide.outcome: noul ≥ min is success, < min is fail with a reason", async () => {
    const mk = () =>
      makeJudgeHandler({
        nodeId: "j",
        state: "x",
        questions: { ok: OK },
        decide: { outcome: { questions: ["ok"], min: 0.7 } },
      });
    const capA = fresh();
    const pass = await mk().handler(stubCtx(capA, { judge: stubJudge({ ok: { type: "noul", noul: 0.7 } }, capA) }));
    if (pass.kind !== "transition") throw new Error(pass.kind);
    expect(pass.outcomeStatus).toBe("success");
    expect(pass.failureReason).toBeUndefined();

    const capB = fresh();
    const failed = await mk().handler(stubCtx(capB, { judge: stubJudge({ ok: { type: "noul", noul: 0.18 } }, capB) }));
    if (failed.kind !== "transition") throw new Error(failed.kind);
    expect(failed.outcomeStatus).toBe("fail");
    expect(failed.failureReason).toMatch(/ok=0\.18 < min 0\.7/);
    expect((failed.outputs as Record<string, unknown>)["ok"]).toEqual({ noul: 0.18 });
    const msg = capB.messages[0]!;
    if (msg.role === "judge_node") expect(msg.decision).toEqual({ kind: "outcome", status: "fail" });
  });

  test("{file} leaves are read through ctx.env and nested mappings serialise as objects", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: { review: { file: "review.md" }, meta: { focus: "${{ inputs.focus }}", pr: "12" } },
      questions: { ok: OK },
    });
    const env = stubEnv({ "review.md": "# Review\nAll clear." });
    await spec.handler(
      stubCtx(cap, {
        judge: stubJudge({ ok: { type: "noul", noul: 1 } }, cap),
        env,
        args: { inputs: { focus: "auth" } },
      }),
    );
    expect(cap.requests[0]!.state).toEqual({ review: "# Review\nAll clear.", meta: { focus: "auth", pr: "12" } });
    expect(cap.events[0]!.payload["stateBytes"]).toBeGreaterThan(0);
  });
});

describe("judge handler — failure modes", () => {
  test("no ctx.judge → error halt naming the provider setup", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
    const result = await spec.handler(stubCtx(cap));
    expect(result).toMatchObject({ kind: "halt", reason: "error" });
    if (result.kind === "halt") expect(result.detail).toMatch(/no judge client wired/);
    expect(cap.requests).toHaveLength(0);
  });

  test("unpopulated ${{ outputs.X.f }} in state fails closed as outcome=fail", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: { d: "${{ outputs.resolve.diff }}" }, questions: { ok: OK } });
    const result = await spec.handler(
      stubCtx(cap, { judge: stubJudge({ ok: { type: "noul", noul: 1 } }, cap), args: { outputs: {} } }),
    );
    expect(result).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (result.kind === "transition") expect(result.failureReason).toMatch(/resolve/);
    expect(cap.requests).toHaveLength(0);
  });

  test("missing state file → outcome=fail naming the path", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: { review: { file: "review.md" } }, questions: { ok: OK } });
    const result = await spec.handler(
      stubCtx(cap, { judge: stubJudge({ ok: { type: "noul", noul: 1 } }, cap), env: stubEnv({}) }),
    );
    expect(result).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (result.kind === "transition") expect(result.failureReason).toMatch(/cannot read "review\.md"/);
  });

  test("{file} leaf with no ctx.env → error halt, never a cwd fallback", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: { review: { file: "review.md" } }, questions: { ok: OK } });
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge({ ok: { type: "noul", noul: 1 } }, cap) }));
    expect(result).toMatchObject({ kind: "halt", reason: "error" });
    if (result.kind === "halt") expect(result.detail).toMatch(/no execution environment/);
  });

  test("state over state-max-bytes → outcome=fail before any request", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: "x".repeat(5000), questions: { ok: OK }, stateMaxBytes: 1024 });
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge({ ok: { type: "noul", noul: 1 } }, cap) }));
    expect(result).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (result.kind === "transition") expect(result.failureReason).toMatch(/over the 1024-byte cap/);
    expect(cap.requests).toHaveLength(0);
  });

  test("429 / 529 / network after client retries → pause_provider", async () => {
    const cases: Array<[number | null, number | undefined]> = [
      [429, 2000],
      [529, undefined],
      [null, undefined],
    ];
    for (const [status, retryAfterMs] of cases) {
      const cap = fresh();
      const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
      const err =
        retryAfterMs === undefined
          ? new JudgeProviderError("busy", "typesafe", status)
          : new JudgeProviderError("busy", "typesafe", status, retryAfterMs);
      const result = await spec.handler(stubCtx(cap, { judge: throwingJudge(err) }));
      expect(result).toMatchObject({ kind: "pause_provider", httpStatus: status, provider: "typesafe" });
      expect("retryAfterMs" in result).toBe(retryAfterMs !== undefined);
      if (retryAfterMs !== undefined) expect(result).toMatchObject({ retryAfterMs });
    }
  });

  test("422 / not-credentialed → error halt with the provider detail", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [
        new JudgeProviderError("Input should be a valid list", "typesafe", 422),
        /rejected by "typesafe" \(422\).*valid list/,
      ],
      [new JudgeNotCredentialedError("typesafe"), /not credentialed/],
    ];
    for (const [err, re] of cases) {
      const cap = fresh();
      const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
      const result = await spec.handler(stubCtx(cap, { judge: throwingJudge(err) }));
      expect(result).toMatchObject({ kind: "halt", reason: "error" });
      if (result.kind === "halt") expect(result.detail).toMatch(re);
    }
  });

  test("abort mid-call → error halt 'judge aborted'", async () => {
    const cap = fresh();
    const ctrl = new AbortController();
    const judge: JudgeClient = {
      provider: "typesafe",
      async ask() {
        ctrl.abort();
        throw new Error("aborted");
      },
    };
    const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
    const result = await spec.handler(stubCtx(cap, { judge, signal: ctrl.signal }));
    expect(result).toMatchObject({ kind: "halt", reason: "error", detail: "judge aborted" });
  });

  test("malformed answers (missing / wrong type / unknown option) → error halt", async () => {
    const spec = () => makeJudgeHandler({ nodeId: "j", state: "x", questions: { size: SIZE, ok: OK } });
    const bad: Array<[Record<string, JudgeAnswer>, RegExp]> = [
      [{ size: sizeAnswer("quick", 0.9) }, /no answer for question "ok"/],
      [{ size: sizeAnswer("quick", 0.9), ok: sizeAnswer("skip", 0.5) }, /asked noul, answered choice/],
      [{ size: sizeAnswer("other", 0.9), ok: { type: "noul", noul: 1 } }, /chose "other", not one of its options/],
    ];
    for (const [answers, re] of bad) {
      const cap = fresh();
      const result = await spec().handler(stubCtx(cap, { judge: stubJudge(answers, cap) }));
      expect(result).toMatchObject({ kind: "halt", reason: "error" });
      if (result.kind === "halt") expect(result.detail).toMatch(re);
      expect(cap.messages).toHaveLength(0);
    }
  });
});

describe("judge handler — decide.outcome over several nouls (all-of)", () => {
  const Q = { calibrated: OK, bar_held: OK, schema_ok: OK };
  const mk = () =>
    makeJudgeHandler({
      nodeId: "verify",
      state: "x",
      questions: Q,
      decide: { outcome: { questions: ["calibrated", "bar_held", "schema_ok"], min: 0.6 } },
    });
  const answers = (c: number, b: number, s: number): Record<string, JudgeAnswer> => ({
    calibrated: { type: "noul", noul: c },
    bar_held: { type: "noul", noul: b },
    schema_ok: { type: "noul", noul: s },
  });

  test("every noul at or above min → success, reason lists them all", async () => {
    const cap = fresh();
    const r = await mk().handler(stubCtx(cap, { judge: stubJudge(answers(0.74, 0.62, 0.78), cap) }));
    expect(r).toMatchObject({ kind: "transition", outcomeStatus: "success" });
  });

  test("one noul below min → fail, reason names only the failing ones", async () => {
    const cap = fresh();
    const r = await mk().handler(stubCtx(cap, { judge: stubJudge(answers(0.74, 0.41, 0.78), cap) }));
    expect(r).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (r.kind === "transition") {
      expect(r.failureReason).toBe("bar_held=0.41 < min 0.6");
    }
  });
});

describe("judge handler — review follow-ups", () => {
  test("401 is a node fail (routable), not a halt", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
    const result = await spec.handler(
      stubCtx(cap, { judge: throwingJudge(new JudgeProviderError("bad key", "typesafe", 401)) }),
    );
    expect(result).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (result.kind === "transition") expect(result.failureReason).toMatch(/rejected the credential \(401\)/);
  });

  test("judge.answered caps a wide choice distribution to the top options and flags it", async () => {
    const cap = fresh();
    const opts: Record<string, string> = {};
    const probs: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      opts[`o${i}`] = `option ${i}`;
      probs[`o${i}`] = i === 7 ? 0.41 : 0.01;
    }
    const spec = makeJudgeHandler({
      nodeId: "j",
      state: "x",
      questions: { pick: { type: "choice", instructions: "pick", criteria: opts } },
    });
    const answers: Record<string, JudgeAnswer> = {
      pick: { type: "choice", choice: "o7", confidence: 0.4, probabilities: probs },
    };
    const result = await spec.handler(stubCtx(cap, { judge: stubJudge(answers, cap) }));
    expect(result.kind).toBe("transition");
    const ev = cap.events.find((e) => e.type === "judge.answered")!;
    const emitted = (ev.payload["answers"] as Record<string, Record<string, unknown>>)["pick"]!;
    expect(Object.keys(emitted["probabilities"] as object)).toHaveLength(32);
    expect((emitted["probabilities"] as Record<string, number>)["o7"]).toBe(0.41);
    expect(emitted["truncated"]).toBe(true);
    // the message row keeps the full distribution
    const msg = cap.messages[0]!;
    if (msg.role === "judge_node") {
      expect(Object.keys((msg.answers["pick"] as { probabilities: object }).probabilities)).toHaveLength(60);
    }
  });
});

describe("judge handler — oversized state at the provider", () => {
  test("400 max_tokens_exceeded is a node fail naming the cause, not a halt", async () => {
    const cap = fresh();
    const spec = makeJudgeHandler({ nodeId: "j", state: "x", questions: { ok: OK } });
    const err = new JudgeProviderError('400: {"detail":{"error_type":"max_tokens_exceeded"}}', "typesafe", 400);
    const result = await spec.handler(stubCtx(cap, { judge: throwingJudge(err) }));
    expect(result).toMatchObject({ kind: "transition", outcomeStatus: "fail" });
    if (result.kind === "transition") expect(result.failureReason).toMatch(/max_tokens_exceeded/);
  });
});

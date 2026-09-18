import { describe, expect, test } from "bun:test";
import type { AgentMessage, JudgeNodeMessage } from "@fragua/types";
import { makeJudgeHandler } from "../../src/handler/handlers/judge.ts";
import type { HandlerContext, ToolRegistry } from "../../src/handler/types.ts";
import {
  JUDGE_USD_PER_INPUT_TOKEN,
  type JudgeAnswer,
  type JudgeClient,
  JudgeProviderError,
  type JudgeQuestion,
  type JudgeRequest,
} from "../../src/types/judge.ts";
import type { OutputsValue } from "../../src/types/outputs.ts";

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

function fresh(): Captured {
  return { messages: [], events: [], requests: [] };
}

function stubJudge(answer: (req: JudgeRequest) => Record<string, JudgeAnswer>, captured: Captured): JudgeClient {
  return {
    provider: "typesafe",
    async ask(req) {
      captured.requests.push(req);
      return {
        model: "jev-1.13.0",
        answers: answer(req),
        usage: { input_tokens: 900, output_tokens: 40 },
        costUsd: 900 * JUDGE_USD_PER_INPUT_TOKEN,
      };
    },
  };
}

function ctxWith(captured: Captured, outputs: Record<string, OutputsValue>, judge?: JudgeClient): HandlerContext {
  return {
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
    args: { outputs },
    emit: (type, payload) => {
      captured.events.push({ type, payload });
    },
    ...(judge !== undefined ? { judge } : {}),
  };
}

const HOLDS: JudgeQuestion = { type: "noul", instructions: "Does `item.cited_code` show `item.claim`?" };
const SEV: JudgeQuestion = {
  type: "score",
  instructions: { question: "How severe is `item.claim`?", given: "`item.cited_code`" },
  criteria: ["low", "medium", "high"],
};

const FINDINGS = [
  { claim: "off by one", cited_code: "for (i = 0; i <= n; i++)" },
  { claim: "unused import", cited_code: "import x" },
  { claim: "null deref", cited_code: "a.b.c" },
];

/** Answer every expanded question by item index: item 1 does not hold. */
function perItem(req: JudgeRequest): Record<string, JudgeAnswer> {
  const out: Record<string, JudgeAnswer> = {};
  for (const id of Object.keys(req.questions)) {
    const i = Number(id.split("__")[1]);
    if (id.startsWith("holds__")) out[id] = { type: "noul", noul: i === 1 ? 0.2 : 0.9 };
    else
      out[id] = {
        type: "score",
        score: i,
        confidence: 0.7,
        legend: { "0": "low", "1": "medium", "2": "high" },
        probabilities: { "0": i === 0 ? 0.8 : 0.1, "1": i === 1 ? 0.8 : 0.1, "2": i === 2 ? 0.8 : 0.1 },
      };
  }
  return out;
}

describe("judge handler — for-each", () => {
  test("one call with N×Q questions; item paths re-aimed; shared state sits beside items", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      state: { diff: "the diff" },
      questions: { holds: HOLDS, sev: SEV },
      keep: { rules: [{ question: "holds", min: 0.6 }] },
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    expect(res.kind).toBe("transition");
    const req = c.requests[0]!;
    expect(Object.keys(req.questions)).toHaveLength(6);
    expect(req.state).toEqual({ diff: "the diff", items: FINDINGS });
    expect(req.questions["holds__2"]!.instructions).toBe("Does `items[2].cited_code` show `items[2].claim`?");
    expect((req.questions["sev__0"]!.instructions as { given: string }).given).toBe("`items[0].cited_code`");
    expect(req.questions["sev__0"]!.criteria).toEqual(["low", "medium", "high"]);
  });

  test("answers align with the input; keep splits kept/dropped carrying item fields + judge", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS, sev: SEV },
      keep: { rules: [{ question: "holds", min: 0.6 }] },
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    if (res.kind !== "transition") throw new Error(res.kind);
    const out = res.outputs!;
    const answers = out["answers"] as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(3);
    expect(answers[1]).toEqual({
      holds: { noul: 0.2 },
      sev: { score: 1, level: 1, confidence: 0.7, probabilities: [0.1, 0.8, 0.1] },
    });
    const kept = out["kept"] as Array<Record<string, unknown>>;
    const dropped = out["dropped"] as Array<Record<string, unknown>>;
    expect(kept.map((k) => k["claim"])).toEqual(["off by one", "null deref"]);
    expect(dropped.map((k) => k["claim"])).toEqual(["unused import"]);
    expect(kept[1]!["judge"]).toEqual({
      holds: { noul: 0.9 },
      sev: { score: 2, level: 2, confidence: 0.7, probabilities: [0.1, 0.1, 0.8] },
    });
    expect(res.outcomeStatus).toBeUndefined();
    const msg = c.messages[0] as JudgeNodeMessage;
    expect(msg.forEach).toEqual({ count: 3, chunks: 1, kept: [0, 2] });
    expect(Object.keys(msg.questions)).toEqual(["holds", "sev"]);
    const requested = c.events.find((e) => e.type === "judge.requested")!.payload;
    expect(requested["forEachCount"]).toBe(3);
    expect(requested["questionIds"]).toEqual(["holds", "sev"]);
    expect(c.events.find((e) => e.type === "judge.answered")!.payload["forEach"]).toEqual({
      count: 3,
      chunks: 1,
      kept: [0, 2],
    });
  });

  test("a list over the request budget is cut into chunks: global ids, chunk-local paths, summed cost", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      state: { diff: "shared" },
      questions: { holds: HOLDS },
      keep: { rules: [{ question: "holds", min: 0.6 }] },
      // ~250 bytes of budget: shared state + one item + one question fit, two items do not
      requestTokenBudget: 250 / 2.2,
      stateTokenBudget: 250 / 2.2,
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    if (res.kind !== "transition") throw new Error(res.kind);
    expect(c.requests).toHaveLength(3);
    // every chunk carries the shared state and ONE item at items[0], asked under its global id
    expect(c.requests.map((r) => Object.keys(r.questions))).toEqual([["holds__0"], ["holds__1"], ["holds__2"]]);
    for (const r of c.requests) {
      const st = r.state as { diff: string; items: unknown[] };
      expect(st.diff).toBe("shared");
      expect(st.items).toHaveLength(1);
      expect(Object.values(r.questions)[0]!.instructions).toBe("Does `items[0].cited_code` show `items[0].claim`?");
    }
    expect(c.requests.map((r) => (r.state as { items: unknown[] }).items[0])).toEqual(FINDINGS);
    // answers fold back to the right items
    const kept = res.outputs!["kept"] as Array<Record<string, unknown>>;
    expect(kept.map((k) => k["claim"])).toEqual(["off by one", "null deref"]);
    // cost and tokens are the sum over chunks; one cost.recorded per chunk
    expect(res.inputTokens).toBe(2700);
    expect(res.costUsd).toBeCloseTo(3 * 900 * JUDGE_USD_PER_INPUT_TOKEN, 12);
    expect(c.events.filter((e) => e.type === "cost.recorded")).toHaveLength(3);
    const msg = c.messages[0] as JudgeNodeMessage;
    expect(msg.forEach).toEqual({ count: 3, chunks: 3, kept: [0, 2] });
    expect(c.events.find((e) => e.type === "judge.requested")!.payload["chunks"]).toBe(3);
  });

  test("a for-each judge.answered event carries the per-item verdicts, not the N×Q answers", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS },
      keep: { rules: [{ question: "holds", min: 0.6 }] },
    });
    await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    const answered = c.events.find((e) => e.type === "judge.answered")!.payload;
    expect(answered["answers"]).toBeUndefined();
    expect(answered["forEach"]).toEqual({ count: 3, chunks: 1, kept: [0, 2] });
  });

  test("a provider failure on a later chunk keeps the earlier chunks' cost in the log", async () => {
    const c = fresh();
    let calls = 0;
    const flaky: JudgeClient = {
      provider: "typesafe",
      async ask(req) {
        c.requests.push(req);
        calls += 1;
        if (calls === 2) throw new JudgeProviderError("rate limited", "typesafe", 429, 1000);
        return {
          model: "jev-1.13.0",
          answers: perItem(req),
          usage: { input_tokens: 900, output_tokens: 40 },
          costUsd: 900 * JUDGE_USD_PER_INPUT_TOKEN,
        };
      },
    };
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS },
      requestTokenBudget: 250 / 2.2,
      stateTokenBudget: 250 / 2.2,
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, flaky));
    expect(res.kind).toBe("pause_provider");
    expect(c.requests).toHaveLength(2);
    expect(c.events.filter((e) => e.type === "cost.recorded")).toHaveLength(1);
  });

  test("an item that cannot fit a request on its own is a routable fail", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS },
      // shared state + one question fit; any item + a question does not
      requestTokenBudget: 100 / 2.2,
      stateTokenBudget: 100 / 2.2,
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    if (res.kind !== "transition") throw new Error(res.kind);
    expect(res.outcomeStatus).toBe("fail");
    expect(res.failureReason).toMatch(/item 0 does not fit/);
    expect(c.requests).toHaveLength(0);
  });

  test("an empty list is a free success with empty outputs", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS },
      keep: { rules: [{ question: "holds", min: 0.6 }] },
    });
    const res = await h.handler(ctxWith(c, { read: { findings: [] } }, stubJudge(perItem, c)));
    if (res.kind !== "transition") throw new Error(res.kind);
    expect(res.outputs).toEqual({ answers: [], kept: [], dropped: [] });
    expect(c.requests).toHaveLength(0);
    expect(c.events.filter((e) => e.type === "cost.recorded")).toHaveLength(0);
  });

  test("over the item cap is a routable fail", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.findings }}",
      questions: { holds: HOLDS },
      forEachMaxItems: 2,
    });
    const res = await h.handler(ctxWith(c, { read: { findings: FINDINGS } }, stubJudge(perItem, c)));
    expect(res.kind).toBe("transition");
    if (res.kind !== "transition") return;
    expect(res.outcomeStatus).toBe("fail");
    expect(res.failureReason).toMatch(/3 items, over the 2-item cap/);
  });

  test("an unpopulated list reference fails closed", async () => {
    const c = fresh();
    const h = makeJudgeHandler({ nodeId: "j", forEach: "${{ outputs.read.findings }}", questions: { holds: HOLDS } });
    const res = await h.handler(ctxWith(c, {}, stubJudge(perItem, c)));
    if (res.kind !== "transition") throw new Error(res.kind);
    expect(res.outcomeStatus).toBe("fail");
    expect(res.failureReason).toMatch(/unpopulated output reference/);
  });

  test("a non-record item is carried under `item`", async () => {
    const c = fresh();
    const h = makeJudgeHandler({
      nodeId: "j",
      forEach: "${{ outputs.read.paths }}",
      questions: { holds: HOLDS },
      keep: { rules: [{ question: "holds", min: 0.5 }] },
    });
    const res = await h.handler(
      ctxWith(
        c,
        { read: { paths: ["a.ts", "b.ts"] } },
        stubJudge(
          (req) => Object.fromEntries(Object.keys(req.questions).map((id) => [id, { type: "noul", noul: 0.9 }])),
          c,
        ),
      ),
    );
    if (res.kind !== "transition") throw new Error(res.kind);
    expect(res.outputs!["kept"]).toEqual([
      { item: "a.ts", judge: { holds: { noul: 0.9 } } },
      { item: "b.ts", judge: { holds: { noul: 0.9 } } },
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { makeJudgeClient, TYPESAFE_BASE_URL } from "../../src/handler/judge-client.ts";
import { JudgeNotCredentialedError, JudgeProviderError, type JudgeRequest } from "../../src/handler/judge-contract.ts";

const REQ: JudgeRequest = {
  model: "jev-latest",
  state: "x",
  questions: { ok: { type: "noul", instructions: "ok?" } },
};

const OK_BODY = JSON.stringify({
  model: "jev-1.13.0",
  answers: { ok: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 12, output_tokens: 3 },
});

function fetchSeq(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const noSleep = async (): Promise<void> => {};
const signal = (): AbortSignal => new AbortController().signal;

describe("makeJudgeClient", () => {
  test("posts the request with the bearer key and parses the response", async () => {
    const { fetch: f, calls } = fetchSeq([new Response(OK_BODY, { status: 200 })]);
    const client = makeJudgeClient({ getApiKey: async () => "sk-test", fetch: f, sleep: noSleep });
    const res = await client.ask(REQ, signal());
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers["ok"]).toEqual({ type: "noul", noul: 0.9 });
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 3 });
    expect(calls[0]!.url).toBe(`${TYPESAFE_BASE_URL}/v1/systemone`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(REQ);
    expect(client.provider).toBe("typesafe");
  });

  test("no credential → JudgeNotCredentialedError before any request", async () => {
    const { fetch: f, calls } = fetchSeq([]);
    const client = makeJudgeClient({ getApiKey: async () => undefined, fetch: f });
    await expect(client.ask(REQ, signal())).rejects.toBeInstanceOf(JudgeNotCredentialedError);
    expect(calls).toHaveLength(0);
  });

  test("429 then 200 → retried once, Retry-After honoured", async () => {
    const slept: number[] = [];
    const { fetch: f, calls } = fetchSeq([
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      new Response(OK_BODY, { status: 200 }),
    ]);
    const client = makeJudgeClient({
      getApiKey: async () => "k",
      fetch: f,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const res = await client.ask(REQ, signal());
    expect(res.model).toBe("jev-1.13.0");
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([2000]);
  });

  test("529 exhausting attempts → JudgeProviderError with status + retryAfter", async () => {
    const { fetch: f, calls } = fetchSeq([
      new Response("busy", { status: 529 }),
      new Response("busy", { status: 529, headers: { "retry-after": "1" } }),
    ]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep, maxAttempts: 2 });
    const err = await client.ask(REQ, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).httpStatus).toBe(529);
    expect((err as JudgeProviderError).retryAfterMs).toBe(1000);
    expect(calls).toHaveLength(2);
  });

  test("422 is not retried and carries the API detail", async () => {
    const detail = JSON.stringify({
      detail: [{ loc: ["body", "questions", "q", "criteria"], msg: "Input should be a valid list" }],
    });
    const { fetch: f, calls } = fetchSeq([new Response(detail, { status: 422 })]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep });
    const err = await client.ask(REQ, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).httpStatus).toBe(422);
    expect((err as JudgeProviderError).message).toMatch(/valid list/);
    expect(calls).toHaveLength(1);
  });

  test("401 is not retried", async () => {
    const { fetch: f, calls } = fetchSeq([new Response("bad key", { status: 401 })]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep });
    const err = await client.ask(REQ, signal()).catch((e: unknown) => e);
    expect((err as JudgeProviderError).httpStatus).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("network error retries, then surfaces httpStatus null", async () => {
    const { fetch: f } = fetchSeq([new Error("ECONNRESET"), new Error("ECONNRESET")]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep, maxAttempts: 2 });
    const err = await client.ask(REQ, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).httpStatus).toBeNull();
    expect((err as JudgeProviderError).message).toMatch(/ECONNRESET/);
  });

  test("a 200 with a non-JSON body is a provider error, not a crash", async () => {
    const { fetch: f } = fetchSeq([new Response("<html>", { status: 200 })]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep });
    const err = await client.ask(REQ, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).httpStatus).toBe(200);
  });

  test("aborted signal propagates the abort, no retry", async () => {
    const ctrl = new AbortController();
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      ctrl.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    }) as unknown as typeof fetch;
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: impl, sleep: noSleep });
    await expect(client.ask(REQ, ctrl.signal)).rejects.toBeDefined();
  });
});

describe("makeJudgeClient — answer shape validation", () => {
  const body = (answers: unknown, model = "jev-1.13.0") =>
    JSON.stringify({ model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
  const ask = async (b: string) => {
    const { fetch: f } = fetchSeq([new Response(b, { status: 200 })]);
    const client = makeJudgeClient({ getApiKey: async () => "k", fetch: f, sleep: noSleep });
    return client.ask(REQ, signal()).catch((e: unknown) => e);
  };

  test.each<[string, unknown, RegExp]>([
    ["choice without probabilities", { q: { type: "choice", choice: "a", confidence: 0.9 } }, /probabilities/],
    [
      "choice with a non-numeric probability",
      { q: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: "high" } } },
      /probabilities/,
    ],
    ["noul without a number", { q: { type: "noul", noul: "yes" } }, /`noul`/],
    ["score without confidence", { q: { type: "score", score: 1, probabilities: { "0": 1 } } }, /confidence/],
    ["unknown type", { q: { type: "rank" } }, /unknown answer type/],
  ])("%s → JudgeProviderError", async (_n, answers, re) => {
    const err = await ask(body(answers));
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).message).toMatch(re);
  });

  test("an implausibly long model id is rejected", async () => {
    const err = await ask(body({ q: { type: "noul", noul: 0.5 } }, "x".repeat(200)));
    expect(err).toBeInstanceOf(JudgeProviderError);
    expect((err as JudgeProviderError).message).toMatch(/model/);
  });
});

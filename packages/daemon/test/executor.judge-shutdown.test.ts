// A judge step interrupted by daemon shutdown must survive the restart: the
// handler rethrows the abort instead of returning an error halt, the executor
// classifies it as a shutdown exit (spend on `fact.node_aborted`, run left
// `running`), and the startup sweep requeues it.

import { describe, expect, test } from "bun:test";
import { JUDGE_BUILTIN_PROVIDERS, type JudgeClient, makeJudgeHandler } from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

const YAML = `name: judge-shutdown
defaults: { provider: anthropic, model: m }
steps:
  gate: { type: llm, prompt: x, next: exit }
`;

describe("judge step under daemon shutdown", () => {
  test("F5: a judge interrupted by daemon shutdown is requeued, not halted", async () => {
    const r = rig({ yaml: YAML });
    const shutdown = new AbortController();
    const judgeClient: JudgeClient = {
      defaultProvider: "typesafe",
      resolve: (id) => JUDGE_BUILTIN_PROVIDERS[id ?? "typesafe"],
      ask: (_req, signal) => {
        shutdown.abort();
        return new Promise((_, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    r.dispatcher.register(
      r.workflowSha,
      "gate",
      makeJudgeHandler({ nodeId: "gate", state: "x", questions: { ok: { type: "noul", instructions: "ok?" } } }),
    );
    enqueue(r, "js1", "gate");
    r.store.claimNextRun(1);
    await runOne("js1", {
      store: r.store,
      dispatcher: r.dispatcher,
      registry: new AbortRegistry(),
      tools: r.tools,
      llmCall: r.llmCall,
      judgeClient,
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 10,
      shutdownSignal: shutdown.signal,
    });

    expect(r.store.getState("js1")!.status).toBe("running");
    const events = r.store.getEvents("js1");
    expect(events.some((e) => e.type === "fact.run_terminated")).toBe(false);
    const aborted = events.find((e) => e.type === "fact.node_aborted");
    expect((aborted!.payload as { nodeId: string; cause: string }).cause).toBe("shutdown");

    expect(r.store.startupSweep().requeued).toContain("js1");
    expect(r.store.getState("js1")!.status).toBe("queued");
    r.store.close();
  });
});

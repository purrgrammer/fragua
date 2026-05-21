// Repro for the "$1.21 → $1.60 leak" observed live during a multi-
// lens review run: when the parent's reactive budget gate fires
// (executor.ts:777 calls steerCtrl.abort(new Error("budget_pause"))),
// in-flight `agent`-tool sub-agents are supposed to abort their LLM
// streams within a short window. The unit-level cascade
// (steerCtrl → input.signal → agent.abort() → tool.execute(signal) →
// spec.signal → childCtrl → child input.signal → child agent.abort())
// is provably wired in subagent.test.ts. This test exercises the same
// cascade through real PiLlmBackend instances + faux providers,
// measuring overshoot: how many child cost.recorded events arrive
// AFTER the parent's abort fires.
//
// Why the executor isn't in the loop: the reactive gate is just
// "watch cost.recorded, abort signal when cumulative > ceiling".
// We can simulate that with a parentEmit wrapper around input.emit,
// keeping the test focused on the abort propagation through pi-agent
// + spawn-subagent rather than the executor's fold logic. The
// executor's own behaviour is covered by executor.budget.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiLlmBackend } from "@fragua/agent";
import { SqliteStore } from "@fragua/store";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { makeSpawnSubagent } from "../src/spawn-subagent.ts";

describe("budget-pause sub-agent leak — overshoot measurement", () => {
  test("parent abort during in-flight sub-agent stream: cost events stop within a bounded window", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-budget-leak-"));
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("wf", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    store.enqueueRun({ runId: "test-leak", workflowSha: "wf" });

    const faux = registerFauxProvider({ tokensPerSecond: 100 });
    try {
      // Very long child response (~6000 chars ≈ 1500 tokens at
      // tokensPerSecond:100 ⇒ 15 seconds of streaming if the abort
      // cascade is broken). The grace wait at end of test is only 6s,
      // so a non-aborted child stream WILL still be running when we
      // assert.
      const longChildText = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(100);

      // Faux replays responses in order. Parent's first stream returns
      // an `agent` tool call; child's first stream returns the long
      // text; parent's would-be second stream returns a stop (unused
      // if the abort lands first, which it should).
      // Six parallel sub-agents matches the live shape (review.yaml
      // fans out to 6 lens reviewers). The parent's turn ends with
      // six toolCalls in one assistant message; pi-agent runs them
      // in parallel via Promise.all.
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("agent", { prompt: "lens 1" }, { id: "tc_c1" }),
            fauxToolCall("agent", { prompt: "lens 2" }, { id: "tc_c2" }),
            fauxToolCall("agent", { prompt: "lens 3" }, { id: "tc_c3" }),
            fauxToolCall("agent", { prompt: "lens 4" }, { id: "tc_c4" }),
            fauxToolCall("agent", { prompt: "lens 5" }, { id: "tc_c5" }),
            fauxToolCall("agent", { prompt: "lens 6" }, { id: "tc_c6" }),
          ],
          { stopReason: "toolUse" },
        ),
        // One slow child response per spawn — they share the queue.
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText(longChildText)], { stopReason: "stop" }),
        fauxAssistantMessage([fauxText("parent done")], { stopReason: "stop" }),
      ]);

      const model = faux.getModel();
      const registry = new ToolRegistry();
      registry.registerAll(CORE_TOOLS);
      const env = new LocalEnvironment({ cwd: scratch });

      const daemonShutdown = new AbortController();
      // Forward-declare so the spawnSubagentFactory closure can refer
      // to the backend that's being constructed in the next statement.
      // eslint-disable-next-line prefer-const
      let backend!: PiLlmBackend;
      backend = new PiLlmBackend({
        registry,
        env,
        resolveModel: () => model,
        defaultModel: { provider: model.provider, model: model.id },
        skills: [],
        spawnSubagentFactory: (parentCtx) =>
          makeSpawnSubagent({ store, registry, backend, shutdownSignal: daemonShutdown.signal }, parentCtx),
      });

      // Reactive-gate stand-in. The real gate accumulates cost and
      // fires when total >= ceiling; we fire on the first cost event
      // so we don't need a contrived ceiling value. Either way the
      // contract under test is the same: input.signal aborts, and
      // child LLM streams must stop within a bounded window.
      const parentSignal = new AbortController();
      let abortFiredAt: number | null = null;
      let costEventsBeforeAbort = 0;
      const costEventsAfterAbort: Array<{ msAfterAbort: number; subagentId: string | undefined }> = [];
      // subagent.end timing is the real "did the child unwind fast"
      // signal. Real Anthropic streams continue to be billed for any
      // tokens that flow before the socket actually tears down; faux
      // doesn't fire message_end on an aborted stream so cost.recorded
      // is a lossy proxy. subagent.end fires regardless, so its
      // timing reliably distinguishes "child aborted within microtasks
      // of parent signal aborting" (good) from "child ran out the
      // 2s ABORT_TEARDOWN_GRACE_MS window" (the bug).
      const subagentEndTimings: number[] = [];

      let thrownStopReason: string | null = null;
      try {
        await backend.run({
          node: { id: "n_parent", type: "llm", attrs: { allowed_tools: ["agent", "read"] } },
          prompt: "spawn a slow sub-agent",
          thread_id: undefined,
          signal: parentSignal.signal,
          run_id: "test-leak",
          workflow_sha: "sha",
          emit: async (type, data) => {
            if (type === "subagent.end" && abortFiredAt !== null) {
              subagentEndTimings.push(Date.now() - abortFiredAt);
            }
            if (type !== "cost.recorded") return;
            if (abortFiredAt === null) {
              costEventsBeforeAbort += 1;
              abortFiredAt = Date.now();
              parentSignal.abort();
            } else {
              costEventsAfterAbort.push({
                msAfterAbort: Date.now() - abortFiredAt,
                subagentId: data["subagent_id"] as string | undefined,
              });
            }
          },
        });
      } catch (err) {
        thrownStopReason = err instanceof Error ? `${err.name}:${err.message}` : String(err);
      }

      // Give detached background work an extra grace window — the
      // bug shape we're hunting is "backend.run returned but
      // sub-agents kept streaming in the background". Wait long
      // enough for any leaked stream to make most of its damage
      // visible (6s vs the 15s full stream).
      await new Promise((r) => setTimeout(r, 6_000));

      // Headline diagnostics — printed unconditionally so the failure
      // output makes the leak shape obvious.
      // eslint-disable-next-line no-console
      console.error(
        `[budget-pause leak repro] thrown=${thrownStopReason ?? "<no throw>"} ` +
          `costEventsBeforeAbort=${costEventsBeforeAbort} ` +
          `costEventsAfterAbort=${costEventsAfterAbort.length} ` +
          `subagentEndTimings=${JSON.stringify(subagentEndTimings)} ` +
          `log=${JSON.stringify(costEventsAfterAbort)}`,
      );

      expect(abortFiredAt).not.toBeNull();
      // All 6 sub-agents must end (status=cancelled) — none stuck
      // in the background.
      expect(subagentEndTimings.length).toBe(6);
      // Headline: every sub-agent unwound well under
      // ABORT_TEARDOWN_GRACE_MS (2s in packages/agent/src/backend.ts).
      // Without the queueMicrotask fix to the eager agent.abort() in
      // backend.run, each sub-agent's child backend would have to
      // wait out the full 2s grace before its outer race throws,
      // burning provider tokens the whole time. A 500ms ceiling
      // catches that regression with a 4× safety margin.
      const slowEnds = subagentEndTimings.filter((ms) => ms > 500);
      expect(slowEnds).toEqual([]);
      // Belt-and-suspenders: any cost events that DID land after
      // abort arrived within the cooperative-unwind window.
      const lateCostEvents = costEventsAfterAbort.filter((e) => e.msAfterAbort > 500);
      expect(lateCostEvents.length).toBe(0);
    } finally {
      faux.unregister();
      store.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

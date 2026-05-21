// Property-based tests pinning the "threaded transcript is invariant
// across daemon restarts" contract. Rehydration from the messages table
// is byte-identical and provider caches either content-hash (Anthropic /
// OpenAI Completions / Google) or key off the stable thread_id (OpenAI
// Responses). These properties lock the invariant in place so a future
// change that reintroduces a thread-content flip on resume fails loudly.
//
// Scripted faux responses keep the Agent loop deterministic: each
// `PiLlmBackend.run()` invocation pops exactly one AssistantMessage
// (no tool calls → stopReason="stop" → no second LLM turn). Comparing
// two runs that differ only in their restart pattern then reduces to
// comparing the final `AgentMessage[]` arrays.

import { describe, expect, test } from "bun:test";
import type { Node } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { SqliteStore } from "@fragua/store";
import { LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import fc from "fast-check";
import { PiLlmBackend } from "../src/backend.ts";
import { makeLlmHandler } from "../src/handler-bridge.ts";

// ───── Helpers ─────────────────────────────────────────────────────────

function nodeOn(threadId: string): Node {
  return {
    id: threadId,
    attrs: {
      type: "llm",
      prompt: `turn on ${threadId}`,
      thread_id: threadId,
    },
  } as unknown as Node;
}

async function ctxFor(runId: string, store: SqliteStore, nodeId: string): Promise<handler.HandlerContext> {
  try {
    store.saveWorkflow("sha", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
  } catch {
    // already saved — same-in-memory-store loop
  }
  try {
    store.enqueueRun({ runId, workflowSha: "sha" });
  } catch {
    // already enqueued — reused runId
  }
  const ac = new AbortController();
  const tools = new handler.InMemoryToolRegistry();
  return handler.buildHandlerContext({
    runId,
    nodeId,
    iteration: 0,
    signal: ac.signal,
    routing: {},
    store,
    llm: handler.makeLlmClient({
      signal: ac.signal,
      call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
    }),
    http: handler.makeHttpClient({ signal: ac.signal }),
    tools,
    args: {},
    recorder: {
      recordIntent: () => {},
      recordDone: () => {},
      recordFailed: () => {},
    },
  });
}

/** Scripted responses — one plain-text assistant turn per call, no tools. */
function scriptedResponses(seed: number, n: number): FauxResponseStep[] {
  const out: FauxResponseStep[] = [];
  for (let i = 0; i < n; i++) {
    out.push(fauxAssistantMessage([fauxText(`reply ${seed}:${i}`)], { stopReason: "stop", timestamp: 1_000 + i }));
  }
  return out;
}

interface DaemonHarness {
  store: SqliteStore;
  makeBackend(inProcessWrites: Set<string>): PiLlmBackend;
  dispatch(backend: PiLlmBackend, runId: string, threadId: string): Promise<{ finalMessages: AgentMessage[] }>;
  /** Tears down the faux registration. */
  dispose(): void;
}

function newDaemon(store: SqliteStore, responses: FauxResponseStep[]): DaemonHarness {
  const faux = registerFauxProvider();
  faux.setResponses(responses);
  const model = faux.getModel();
  return {
    store,
    makeBackend(inProcessWrites) {
      return new PiLlmBackend({
        registry: new ToolRegistry(),
        env: new LocalEnvironment({ cwd: process.cwd() }),
        resolveModel: () => model,
        defaultModel: { provider: model.provider, model: model.id },
        inProcessWrites,
      });
    },
    async dispatch(backend, runId, threadId) {
      const ctx = await ctxFor(runId, store, threadId);
      const spec = makeLlmHandler({ node: nodeOn(threadId), backend });
      await spec.handler(ctx);
      // Return the full persisted transcript for this run (all threads).
      const rows = store.getMessages(runId);
      return { finalMessages: rows.map((r) => r.content) };
    },
    dispose: () => faux.unregister(),
  };
}

/** Strip fields that the faux provider synthesises per-registration
 * (api string, input/cache token counts). The semantic payload — role,
 * content blocks, stopReason, thinkingSignature, toolCallId — stays
 * under comparison, which is what the invariant is about. */
function canonicalise(messages: AgentMessage[]): string {
  return JSON.stringify(
    messages.map((m) => {
      const clone = JSON.parse(JSON.stringify(m)) as Record<string, unknown>;
      delete clone["api"];
      delete clone["timestamp"];
      if (clone["usage"] && typeof clone["usage"] === "object") delete clone["usage"];
      return clone;
    }),
  );
}

function reseedInProcessWrites(store: SqliteStore): Set<string> {
  const out = new Set<string>();
  for (const pair of store.listThreadsWithMessages()) {
    out.add(`${pair.runId}::${pair.threadId}`);
  }
  return out;
}

// ───── Property 1 — byte-identical transcript across arbitrary restart pattern ─

describe("threaded transcript is content-invariant across daemon restart patterns", () => {
  test("identical scripted responses → identical final transcript regardless of restart mask", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
        async (turns, maskRaw) => {
          const mask = maskRaw.slice(0, turns);
          while (mask.length < turns) mask.push(false);

          const runReference = async (): Promise<AgentMessage[]> => {
            const store = new SqliteStore({ path: ":memory:" });
            const h = newDaemon(store, scriptedResponses(7, turns));
            try {
              const writes = new Set<string>();
              const backend = h.makeBackend(writes);
              let last: AgentMessage[] = [];
              for (let i = 0; i < turns; i++) {
                ({ finalMessages: last } = await h.dispatch(backend, "r", "dev"));
              }
              return last;
            } finally {
              h.dispose();
              store.close();
            }
          };

          const runWithRestarts = async (): Promise<AgentMessage[]> => {
            const store = new SqliteStore({ path: ":memory:" });
            // Separate faux registration per-daemon-life so each simulated
            // restart gets a fresh response queue.
            let writes = new Set<string>();
            let last: AgentMessage[] = [];
            for (let i = 0; i < turns; i++) {
              const lifeTurns = 1;
              const h = newDaemon(store, scriptedResponses(7, turns).slice(i, i + lifeTurns));
              try {
                const backend = h.makeBackend(writes);
                ({ finalMessages: last } = await h.dispatch(backend, "r", "dev"));
              } finally {
                h.dispose();
              }
              // Simulate restart boundary when the mask says so.
              if (i < turns - 1 && mask[i]) {
                writes = reseedInProcessWrites(store);
              }
            }
            store.close();
            return last;
          };

          const a = await runReference();
          const b = await runWithRestarts();
          expect(canonicalise(b)).toBe(canonicalise(a));
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ───── Property 2 — boot reconstruction matches live Set ────────────────

describe("inProcessWrites boot reconstruction matches live in-process state", () => {
  test("across arbitrary dispatch sequences, reseed(store) equals the live Set", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            runId: fc.constantFrom("r1", "r2", "r3"),
            threadId: fc.constantFrom("dev", "review", "plan"),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (ops) => {
          const store = new SqliteStore({ path: ":memory:" });
          const h = newDaemon(store, scriptedResponses(42, ops.length));
          try {
            const writes = new Set<string>();
            const backend = h.makeBackend(writes);
            for (const op of ops) {
              await h.dispatch(backend, op.runId, op.threadId);
            }
            const rebuilt = reseedInProcessWrites(store);
            // Rebuilt is derived from persisted messages + llm.start events:
            // it must be a superset-or-equal of the live writes, and for
            // every live entry there must be a matching rebuilt entry on
            // the same (run, thread).
            for (const key of writes) {
              expect(rebuilt.has(key)).toBe(true);
            }
            // And no spurious entries: every rebuilt key corresponds to a
            // dispatch we actually issued (weaker: to a run/thread pair
            // we dispatched on at least once).
            const everDispatched = new Set(ops.map((o) => `${o.runId}::${o.threadId}`));
            for (const key of rebuilt) {
              expect(everDispatched.has(key)).toBe(true);
            }
          } finally {
            h.dispose();
            store.close();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ───── Property 3 — no false-positive resume within one daemon life ────

describe("resume detection never false-positives within a live daemon", () => {
  test("every dispatch after the first on a thread has resumed=false when sharing a Set", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            runId: fc.constantFrom("r1", "r2"),
            threadId: fc.constantFrom("dev", "review"),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        async (ops) => {
          const store = new SqliteStore({ path: ":memory:" });
          const h = newDaemon(store, scriptedResponses(99, ops.length));
          try {
            const writes = new Set<string>();
            const backend = h.makeBackend(writes);
            const seen = new Set<string>();
            for (const op of ops) {
              const key = `${op.runId}::${op.threadId}`;
              const hadBefore = seen.has(key);
              // Snapshot resume detection (inlined in backend.run) against
              // the same Set + persisted transcript. Formula:
              //   resumed = priorLen > 0 && !inProcessWrites.has(key)
              const priorBefore = store.getMessages(op.runId).filter((m) => m.nodeId === op.threadId).length;
              const resumed = priorBefore > 0 && !writes.has(key);
              if (hadBefore) {
                expect(resumed).toBe(false);
              }
              await h.dispatch(backend, op.runId, op.threadId);
              seen.add(key);
            }
          } finally {
            h.dispose();
            store.close();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ───── Property 4 — restart at an arbitrary turn preserves transcript ──

describe("restart-at-turn-k preserves the final transcript byte-for-byte", () => {
  test("two runs diverging only in a single restart point converge on the same messages", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 3, max: 4 }), fc.integer({ min: 1, max: 3 }), async (turns, k) => {
        const restartAt = Math.min(k, turns - 1);

        const runNoRestart = async (): Promise<AgentMessage[]> => {
          const store = new SqliteStore({ path: ":memory:" });
          const h = newDaemon(store, scriptedResponses(11, turns));
          try {
            const writes = new Set<string>();
            const backend = h.makeBackend(writes);
            let last: AgentMessage[] = [];
            for (let i = 0; i < turns; i++) {
              ({ finalMessages: last } = await h.dispatch(backend, "r", "dev"));
            }
            return last;
          } finally {
            h.dispose();
            store.close();
          }
        };

        const runWithRestart = async (): Promise<AgentMessage[]> => {
          const store = new SqliteStore({ path: ":memory:" });
          const pre = newDaemon(store, scriptedResponses(11, restartAt));
          let last: AgentMessage[] = [];
          try {
            const writes = new Set<string>();
            const backend = pre.makeBackend(writes);
            for (let i = 0; i < restartAt; i++) {
              ({ finalMessages: last } = await pre.dispatch(backend, "r", "dev"));
            }
          } finally {
            pre.dispose();
          }
          // Simulated restart: reseed writes from store, spin a new
          // faux provider with the remaining scripted turns.
          const post = newDaemon(store, scriptedResponses(11, turns).slice(restartAt));
          try {
            const writes = reseedInProcessWrites(store);
            const backend = post.makeBackend(writes);
            for (let i = restartAt; i < turns; i++) {
              ({ finalMessages: last } = await post.dispatch(backend, "r", "dev"));
            }
          } finally {
            post.dispose();
            store.close();
          }
          return last;
        };

        const a = await runNoRestart();
        const b = await runWithRestart();
        expect(canonicalise(b)).toBe(canonicalise(a));
      }),
      { numRuns: 15 },
    );
  });
});

// ───── Example-based anchors ────────────────────────────────────────────

describe("restart walkthrough — example-based", () => {
  test("two-turn run with a restart between turns preserves the full transcript", async () => {
    const store = new SqliteStore({ path: ":memory:" });

    // Life A — one turn, then the daemon goes away.
    {
      const h = newDaemon(store, [
        fauxAssistantMessage([fauxText("turn 1 done")], { stopReason: "stop", timestamp: 1 }),
      ]);
      try {
        const writes = new Set<string>();
        const backend = h.makeBackend(writes);
        await h.dispatch(backend, "r", "dev");
      } finally {
        h.dispose();
      }
    }

    // Life B — boot, reseed writes from store, finish turn 2.
    {
      const h = newDaemon(store, [
        fauxAssistantMessage([fauxText("turn 2 done")], { stopReason: "stop", timestamp: 2 }),
      ]);
      try {
        const writes = reseedInProcessWrites(store);
        // hasInProcessWrite must already be true for ("r","dev") — the
        // restart signal stays observational.
        expect(writes.has("r::dev")).toBe(true);
        const backend = h.makeBackend(writes);
        await h.dispatch(backend, "r", "dev");
      } finally {
        h.dispose();
      }
    }

    const rows = store.getMessages("r");
    const assistantTexts = rows
      .filter((r) => r.content.role === "assistant")
      .map((r) => {
        const c = r.content as { content: Array<{ type: string; text?: string }> };
        return c.content.find((b) => b.type === "text")?.text ?? "";
      });
    expect(assistantTexts).toEqual(["turn 1 done", "turn 2 done"]);
    store.close();
  });

  test("two back-to-back nodes on one daemon life do not flag resumed=true", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    const h = newDaemon(store, scriptedResponses(3, 2));
    try {
      const writes = new Set<string>();
      // Same pattern as the daemon: one backend per node, shared Set.
      const implement = h.makeBackend(writes);
      const verify = h.makeBackend(writes);
      await h.dispatch(implement, "r", "dev");
      // At dispatch time for `verify`, the shared Set already has r::dev.
      expect(writes.has("r::dev")).toBe(true);
      // Inlined resume detection: resumed iff priorLen > 0 AND not in writes.
      const priorLen = store.getMessages("r").length;
      const resumed = priorLen > 0 && !writes.has("r::dev");
      expect(resumed).toBe(false);
      await h.dispatch(verify, "r", "dev");
    } finally {
      h.dispose();
      store.close();
    }
  });
});

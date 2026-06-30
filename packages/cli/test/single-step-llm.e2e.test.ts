// First end-to-end harness — boots the real executor (the daemon's
// `buildExecutorDeps` assembly) against an EPHEMERAL store, enqueues a
// single-step `llm` workflow, and stubs the LLM provider at the HTTP boundary
// (a `globalThis.fetch` override returning an Anthropic SSE stream) rather than
// injecting a scripted `HandlerSpec`. The point is to exercise the genuine
// backend → handler bridge: the model "response" travels through pi-ai, the
// agent loop, and the handler-bridge into a `fact.node_completed`, exactly as a
// live provider would drive it.
//
// Contrast with `packages/daemon/test/driven-executor.property.test.ts`, which
// scripts `HandlerSpec` stubs and never touches the real backend or a provider
// request. Here the only thing faked is the network: the run reaches
// `completed` through the same intent → fact → projection path the daemon uses.
//
// Hermetic + deterministic: ephemeral temp DB (never `~/.fragua/fragua.db`),
// non-git temp cwd (a `LocalEnvironment`, no worktree), provider creds seeded
// from a fake env var through the same `seedCredsFromEnv` bridge `fragua ci`
// uses, and every outbound fetch intercepted — an unexpected URL throws so a
// stray network call fails the test loudly. The terminal-state wait is driven
// by the production `waitCommand` primitive against the same store path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeIntentPlane } from "@fragua/core/intent-plane";
import { makeReadPlane } from "@fragua/core/read-plane";
import { AbortRegistry, type ExecutorOpts, runOne, WorktreeProvisioner } from "@fragua/daemon";
import { newRunId, SqliteStore, type StoredEvent } from "@fragua/store";
import { CLI_EXIT } from "../src/cli-exit.ts";
import { waitCommand } from "../src/commands/wait.ts";
import { loadConfig, resolveTimeouts } from "../src/config.ts";
import { seedCredsFromEnv } from "../src/env-creds.ts";
import { buildExecutorDeps } from "../src/executor-deps.ts";
import { resolveProject } from "../src/project.ts";

const PROVIDER = "anthropic";
const MODEL = "claude-haiku-4-5";
const STUB_TEXT = "Hello from the HTTP-level provider stub.";

const TERMINAL = new Set(["completed", "halted", "cancelled", "quarantined"]);

/** Build the Anthropic streaming SSE body pi-ai parses (`iterateAnthropicEvents`):
 * message_start → content_block_start(text) → text_delta → content_block_stop →
 * message_delta(end_turn) → message_stop. A plain text turn with no tool calls,
 * so the agent loop ends and the llm node completes. */
function anthropicSseBody(text: string): string {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return [
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_stub_1",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

/** Install a `globalThis.fetch` override that answers the provider's
 * `/v1/messages` POST with a canned SSE stream and throws on any other URL —
 * the hermetic guard: nothing else may hit the network. Returns a restore fn. */
function stubProviderFetch(text: string): { restore: () => void; calls: () => number } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/v1/messages")) {
      calls++;
      const bytes = new TextEncoder().encode(anthropicSseBody(text));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`e2e: unexpected network call to ${url} (init: ${init?.method ?? "GET"})`);
  }) as typeof globalThis.fetch;
  const restore = () => {
    globalThis.fetch = original;
  };
  return { restore, calls: () => calls };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let dir: string;
let dbPath: string;
let prevKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fragua-e2e-"));
  dbPath = join(dir, "e2e.db");
  prevKey = process.env["ANTHROPIC_API_KEY"];
  // A fake API key, never an OAuth token (`sk-ant-oat…`), so the provider takes
  // the x-api-key path. The value is irrelevant — fetch is stubbed.
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-e2e-stub-key-0000000000";
});
afterEach(() => {
  if (prevKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = prevKey;
  rmSync(dir, { recursive: true, force: true });
});

describe("e2e: single-step llm workflow over an HTTP-stubbed provider", () => {
  test("boots the executor on an ephemeral store, runs to completed, emits the expected fact sequence", async () => {
    const stub = stubProviderFetch(STUB_TEXT);
    const store = new SqliteStore({ path: dbPath });
    const shutdown = new AbortController();
    const provisioner = new WorktreeProvisioner();
    let runId: string | undefined;
    try {
      // Seed creds the same way `fragua ci` does — from env, into THIS store's
      // provider_credentials. No global-store read (never touch the live store).
      const seeded = seedCredsFromEnv(store);
      expect(seeded).toContain(PROVIDER);

      const config = await loadConfig(dir);
      const timeouts = resolveTimeouts(config);
      // `homeDir: dir` keeps skills discovery hermetic — no scan of the real `~`.
      const deps = await buildExecutorDeps({
        store,
        cwd: dir,
        config,
        timeouts,
        provider: PROVIDER,
        model: MODEL,
        homeDir: dir,
      });
      expect(deps.llm.useLlm).toBe(true);

      // Enqueue a single `llm` step through the real intent plane.
      const project = await resolveProject(dir);
      const plane = makeIntentPlane({ store, newRunId });
      const source =
        "name: e2e-single-step\nsteps:\n  greet:\n    type: llm\n    prompt: Say hello, then stop.\n    next: exit\n";
      const mint = plane.buildSaveWorkflow(source);
      if (!mint.ok) throw new Error(`workflow mint failed: ${mint.detail}`);
      plane.commitSaveWorkflow({
        sha: mint.sha,
        name: "e2e-single-step",
        source,
        ir: mint.ir,
        irVersion: mint.irVersion,
      });
      const enq = plane.buildEnqueue({
        workflowSha: mint.sha,
        inputDecls: mint.graph.attrs.inputs ?? [],
        cwd: resolve(dir),
        projectId: project.projectId,
        projectName: project.projectName,
        workflowScope: "ephemeral",
      });
      if (!enq.ok) throw new Error(`enqueue failed: ${enq.error}`);
      plane.commitEnqueue(enq.params);
      runId = enq.runId;
      const rid = runId;

      const execOpts: ExecutorOpts = {
        store,
        dispatcher: deps.dispatcher,
        registry: new AbortRegistry(),
        tools: deps.tools,
        llmCall: deps.llmCall,
        maxConcurrentRuns: 1,
        shutdownSignal: shutdown.signal,
        provisioner,
        graphLoader: deps.graphLoader,
      };

      // Driver fiber: the daemon's claim → runOne tick until terminal.
      const driver = (async () => {
        for (let i = 0; i < 200 && !shutdown.signal.aborted; i++) {
          const claimed = store.claimNextRun(1);
          if (claimed?.runId === rid) await runOne(rid, execOpts);
          const st = store.getState(rid)?.status;
          if (st !== undefined && TERMINAL.has(st)) return;
          await sleep(5);
        }
      })();

      // Wait for terminal via the production primitive, against the same store.
      const code = await waitCommand({ ids: [rid], dbPath, pollMs: 10, timeout: "30s", settle: "terminal" });
      await driver;
      expect(code).toBe(CLI_EXIT.ok);

      // The provider was actually hit at the HTTP boundary.
      expect(stub.calls()).toBeGreaterThanOrEqual(1);

      // Final projection + event-log shape.
      expect(store.getState(rid)?.status).toBe("completed");
      const events = makeReadPlane({ store }).events(rid) ?? [];
      // The `fact.*` spine — the durable lifecycle, with the observability
      // deltas (`llm.*` / `agent.*` / `edge.selected`) filtered out.
      const facts = events.filter((e) => e.type.startsWith("fact."));
      const factTypes = facts.map((e) => e.type);
      const nodeOf = (e: StoredEvent) => (e.payload as { nodeId?: string }).nodeId;

      // The terminal fact is last and is a clean completion.
      const last = events.at(-1) as StoredEvent;
      expect(last.type).toBe("fact.run_terminated");
      expect((last.payload as { status?: string }).status).toBe("completed");

      // run_started is the first fact, exactly one terminal, no fault/pause.
      expect(factTypes[0]).toBe("fact.run_started");
      expect(factTypes.filter((t) => t === "fact.run_terminated").length).toBe(1);
      expect(factTypes).not.toContain("fact.run_paused");
      expect(factTypes).not.toContain("fact.node_aborted");

      // The single `greet` node threads the dispatch spine in order:
      // node_started → dispatch_started → message_appended → node_completed.
      const seqOf = (type: string, node?: string): number => {
        const i = facts.findIndex((e) => e.type === type && (node === undefined || nodeOf(e) === node));
        expect(i).toBeGreaterThanOrEqual(0);
        return i;
      };
      const started = seqOf("fact.node_started", "greet");
      const dispatched = seqOf("fact.dispatch_started", "greet");
      const messaged = seqOf("fact.message_appended", "greet");
      const completed = seqOf("fact.node_completed", "greet");
      const terminated = seqOf("fact.run_terminated");
      expect(started).toBeLessThan(dispatched);
      expect(dispatched).toBeLessThan(messaged);
      expect(messaged).toBeLessThan(completed);
      expect(completed).toBeLessThan(terminated);
      // The assistant text travelled through the backend → handler bridge.
      expect(facts.some((e) => e.type === "fact.message_appended" && nodeOf(e) === "greet")).toBe(true);
    } finally {
      stub.restore();
      shutdown.abort();
      if (runId !== undefined) {
        try {
          await provisioner.dispose(runId);
        } catch {
          // never provisioned / already disposed
        }
      }
      store.close();
    }
  }, 60_000);
});

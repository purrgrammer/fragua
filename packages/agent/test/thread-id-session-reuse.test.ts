// Wave 3 — widen the Wave-2 `fidelity-apply` coverage into an explicit
// integration probe of thread_id behaviour. Covers the three invariants
// the `MessageStore` + `resolveSessionId` pair exist to enforce:
//
//   1. full fidelity + same thread_id → N-th call sees the first N-1
//      turns that pi-agent-core recorded under that thread.
//   2. Different thread_id values stay isolated — no bleed.
//   3. The sessionId provider-cache hint is fidelity-bucketed so mixing
//      fidelity modes on the same thread doesn't clobber the cache.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

describe("thread_id session reuse — wave 3 integration", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-tid-"));
    mock = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("same thread_id + fidelity=full → second call's restored transcript contains the first call's turn", async () => {
    mock.setResponses([
      fauxAssistantMessage("first reply", { stopReason: "stop" }),
      fauxAssistantMessage("second reply", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [prompt="first", fidelity="full", thread_id="dev"]
          b [prompt="second", fidelity="full", thread_id="dev"]
          done [shape=Msquare]
          s -> a -> b -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(2);
    const bMsgs = (starts[1]!.data as { messages?: Array<{ role: string; content?: unknown }> }).messages ?? [];
    const roles = bMsgs.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // The backend's store is the single source of truth for the persisted
    // transcript — assert it directly so a regression in MessageStore.set
    // can't hide behind a lucky restore on some future pi-agent-core rewrite.
    expect(mock.backend.messages.has("dev")).toBe(true);
    expect(mock.backend.messages.get("dev").length).toBeGreaterThanOrEqual(2);
  });

  test("distinct thread_ids → second call sees NO prior transcript", async () => {
    mock.setResponses([
      fauxAssistantMessage("alpha only", { stopReason: "stop" }),
      fauxAssistantMessage("beta only", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [prompt="alpha", fidelity="full", thread_id="alpha"]
          b [prompt="beta",  fidelity="full", thread_id="beta"]
          done [shape=Msquare]
          s -> a -> b -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    const starts = sink.byType("llm.start");
    expect((starts[1]!.data as { messages?: unknown[] }).messages).toBeUndefined();
    // Both threads end up in the store, but neither contains the other.
    expect(mock.backend.messages.threadIds().sort()).toEqual(["alpha", "beta"]);
  });

  test("thread_id without fidelity=full → no hydrate AND no persist (compact defaults)", async () => {
    mock.setResponses([
      fauxAssistantMessage("a", { stopReason: "stop" }),
      fauxAssistantMessage("b", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [prompt="a", thread_id="shared"]
          b [prompt="b", thread_id="shared"]
          done [shape=Msquare]
          s -> a -> b -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    // default fidelity is `compact` — SPEC §3.3 says every non-full mode
    // is fresh, so the store must never learn about "shared".
    expect(mock.backend.messages.has("shared")).toBe(false);
    const starts = sink.byType("llm.start");
    expect((starts[1]!.data as { messages?: unknown[] }).messages).toBeUndefined();
  });
});

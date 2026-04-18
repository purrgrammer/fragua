// Integration tests for fidelity-driven behaviour running through a real
// PiCodergenBackend + faux pi-ai provider. These assert the big-picture
// claims the SPEC makes in §3.3:
//
//   - full    — thread_id session reuse: turn N sees turn N-1
//   - truncate — fresh session, seed with goal only
//   - compact — fresh session, seed with digest of prior turns
//   - context=fresh — hard opt-out even on the shared thread

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

describe("fidelity end-to-end", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-fidelity-"));
    mock = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("fidelity=full + same thread_id → second call sees first call's messages", async () => {
    mock.setResponses([
      fauxAssistantMessage("alpha response", { stopReason: "stop" }),
      fauxAssistantMessage("beta response", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        alpha [prompt="alpha q", fidelity="full", thread_id="dev"]
        beta  [prompt="beta q",  fidelity="full", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(2);
    // First call: no prior messages (fresh store).
    expect((starts[0]!.data as { messages?: unknown[] }).messages).toBeUndefined();
    // Second call: the prior turns (user+assistant for alpha) are visible.
    const betaMessages = (starts[1]!.data as { messages?: Array<{ role: string }> }).messages;
    expect(betaMessages?.length).toBeGreaterThanOrEqual(2);
    const roles = betaMessages!.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    // The stored transcript is durable on the backend for a subsequent run
    // on the same thread_id.
    expect(mock.backend.messages.has("dev")).toBe(true);
  });

  test("fidelity=truncate → second call sees NO prior messages + seed frames the goal", async () => {
    mock.setResponses([
      fauxAssistantMessage("alpha response", { stopReason: "stop" }),
      fauxAssistantMessage("beta response", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        graph [goal="test truncate carries goal only"]
        s [shape=Mdiamond]
        alpha [prompt="alpha q", fidelity="full", thread_id="dev"]
        beta  [prompt="beta q",  fidelity="truncate", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(2);
    const betaPrompt = (starts[1]!.data as { prompt?: string }).prompt ?? "";
    expect(betaPrompt).toContain('fidelity="truncate"');
    expect(betaPrompt).toContain("test truncate carries goal only");
    expect(betaPrompt).toContain("No prior conversation");
    // Truncate is fresh — no messages restored into initialState.
    expect((starts[1]!.data as { messages?: unknown[] }).messages).toBeUndefined();
  });

  test("fidelity=compact → second call's prompt digests prior turns without restoring them", async () => {
    mock.setResponses([
      fauxAssistantMessage("the big answer is 42", { stopReason: "stop" }),
      fauxAssistantMessage("got it", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        graph [goal="compact demo"]
        s [shape=Mdiamond]
        alpha [prompt="what's the answer?", fidelity="full", thread_id="dev"]
        beta  [prompt="follow up",           fidelity="compact", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    const betaPrompt = (starts[1]!.data as { prompt?: string }).prompt ?? "";
    expect(betaPrompt).toContain('fidelity="compact"');
    expect(betaPrompt).toContain("Prior turns:");
    expect(betaPrompt).toContain("the big answer is 42");
    // Digest in the user prompt, not an actual restored messages array.
    expect((starts[1]!.data as { messages?: unknown[] }).messages).toBeUndefined();
  });

  test('context="fresh" on a full-fidelity node still forces fresh semantics', async () => {
    mock.setResponses([
      fauxAssistantMessage("alpha", { stopReason: "stop" }),
      fauxAssistantMessage("beta", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        alpha [prompt="alpha",              fidelity="full", thread_id="dev"]
        beta  [prompt="beta isolated query", fidelity="full", thread_id="dev", context="fresh"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(2);
    // Second call was explicitly fresh — no prior messages restored.
    expect((starts[1]!.data as { messages?: unknown[] }).messages).toBeUndefined();
    // But the first call still persisted (it was full + no fresh flag) so a
    // later `dev` thread user could still observe alpha's transcript.
    expect(mock.backend.messages.has("dev")).toBe(true);
  });

  test("per-node system_prompt override replaces the global one", async () => {
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hi", system_prompt="you are a reviewer", fidelity="full"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const d = sink.byType("llm.start")[0]!.data as { system_prompt?: string };
    expect(d.system_prompt).toBe("you are a reviewer");
  });

  test("summary:medium warns that the summariser backend isn't wired", async () => {
    mock.setResponses([
      fauxAssistantMessage("alpha", { stopReason: "stop" }),
      fauxAssistantMessage("beta", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        alpha [prompt="alpha", fidelity="full", thread_id="dev"]
        beta  [prompt="beta",  fidelity="summary:medium", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const warnings = sink.byType("agent.warning").map((e) => (e.data as { message?: string }).message ?? "");
    expect(warnings.some((w) => w.includes("summariser backend") && w.includes("summary:medium"))).toBe(true);
  });
});

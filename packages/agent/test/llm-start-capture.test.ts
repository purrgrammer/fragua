// Wave 1 — capture completeness. `events.jsonl` alone must be enough to
// reconstruct "what the agent saw at step N". These tests exercise the full
// backend.run path through the faux pi-ai provider and assert that every
// Wave 1 field on `llm.start` lands as promised. Higher-value than a
// shape-assertion on a mocked payload because they catch the "field
// declared but never populated" class of bug (cf. pre-Wave-1 `iteration`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

describe("llm.start capture — Wave 1 fields", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-llm-start-"));
    mock = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("single-turn captures prompt, system_prompt, model, provider, tools", async () => {
    mock.setResponses([fauxAssistantMessage("done", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    // fidelity=full suppresses the Wave-2 fidelity seed so we can assert
    // the raw prompt lands as-is. Default (compact) prepends a
    // <swarm-context> block — exercised in the dedicated fidelity-apply
    // tests below.
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hello world", fidelity="full", allowed_tools=""]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(1);
    const d = starts[0]!.data as Record<string, unknown>;
    expect(d["prompt"]).toBe("hello world");
    expect(typeof d["system_prompt"]).toBe("string");
    expect(typeof d["model"]).toBe("string");
    expect(typeof d["provider"]).toBe("string");
    // No prior session → no `messages`, no `context_files`, no `iteration`.
    expect(d["messages"]).toBeUndefined();
    expect(d["context_files"]).toBeUndefined();
    expect(d["iteration"]).toBeUndefined();
  });

  test("every event carries schema_version", async () => {
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hi"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const versions = sink.snapshot().map((e) => e.schema_version);
    expect(versions.length).toBeGreaterThan(0);
    // All events stamp the current version (1). If a future wave bumps it,
    // adjust this assertion in the same commit — it's a canary.
    for (const v of versions) expect(v).toBe(1);
  });

  test("context_files records land on llm.start with sha256 + bytes", async () => {
    await writeFile(join(scratch, "AGENTS.md"), "# conventions\n");
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hi", context_files="AGENTS.md"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const d = sink.byType("llm.start")[0]!.data as {
      context_files?: Array<{ path: string; sha256: string; bytes: number; truncated: boolean; status: string }>;
    };
    expect(d.context_files).toHaveLength(1);
    expect(d.context_files![0]).toMatchObject({
      path: "AGENTS.md",
      status: "ok",
      truncated: false,
      bytes: "# conventions\n".length,
    });
    expect(d.context_files![0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("missing context_file is captured with status=missing", async () => {
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hi", context_files="DOES_NOT_EXIST.md"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const d = sink.byType("llm.start")[0]!.data as { context_files?: Array<{ path: string; status: string }> };
    expect(d.context_files).toHaveLength(1);
    expect(d.context_files![0]).toMatchObject({ path: "DOES_NOT_EXIST.md", status: "missing" });
  });

  test("reasoning_effort on node.attrs surfaces on llm.start.settings", async () => {
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="think hard", reasoning_effort="high"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const d = sink.byType("llm.start")[0]!.data as { settings?: { reasoning_effort?: string } };
    expect(d.settings).toBeDefined();
    expect(d.settings!.reasoning_effort).toBe("high");
  });

  test("loop iteration stamps { n, max } on every llm.start", async () => {
    // First two iterations return non-terminal text; third emits the promise.
    mock.setResponses([
      fauxAssistantMessage("still working", { stopReason: "stop" }),
      fauxAssistantMessage("closer", { stopReason: "stop" }),
      fauxAssistantMessage("<promise>DONE</promise>", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        loop [shape=trapezium, prompt="work until done", until="DONE", max_iterations=3]
        done [shape=Msquare]
        s -> loop -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(3);
    const iterations = starts.map((e) => (e.data as { iteration?: { n: number; max: number } }).iteration);
    expect(iterations[0]).toEqual({ n: 1, max: 3 });
    expect(iterations[1]).toEqual({ n: 2, max: 3 });
    expect(iterations[2]).toEqual({ n: 3, max: 3 });
  });

  test("budget snapshot only emitted when max_cost_usd is set", async () => {
    mock.setResponses([
      fauxAssistantMessage("ok", { stopReason: "stop" }),
      fauxAssistantMessage("ok", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        capped [prompt="do it", max_cost_usd=0.5]
        uncapped [prompt="do it"]
        done [shape=Msquare]
        s -> capped -> uncapped -> done
      }
    `);
    await execute({ graph, sink, backend: mock.backend });

    const starts = sink.byType("llm.start");
    expect(starts).toHaveLength(2);
    const a = starts[0]!.data as {
      budget?: { max_cost_usd?: number; cumulative_cost_usd: number; cumulative_tokens: number };
    };
    const b = starts[1]!.data as { budget?: unknown };
    expect(a.budget).toMatchObject({ max_cost_usd: 0.5, cumulative_cost_usd: 0, cumulative_tokens: 0 });
    expect(b.budget).toBeUndefined();
  });
});

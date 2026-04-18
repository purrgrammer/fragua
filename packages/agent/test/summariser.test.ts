// Unit + wiring tests for Wave 2b: PiSummariserBackend behaviour + its
// integration with fidelity=summary:medium|high through PiCodergenBackend.
// Uses a tiny stub summariser so the test stays hermetic (no pi-ai
// network calls, no live summariser model registration).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SummariseInput, SummariseOutput, SummariserBackend } from "@swarm/core";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

class RecordingSummariser implements SummariserBackend {
  calls: SummariseInput[] = [];
  output: Pick<SummariseOutput, "text" | "ok" | "error"> = { text: "compressed summary body", ok: true };

  async summarise(input: SummariseInput): Promise<SummariseOutput> {
    this.calls.push(input);
    if (input.emit) {
      await input.emit(
        "summary.started",
        { purpose: input.purpose, provider: "stub", model: "stub-small", caller_node_id: input.caller_node_id },
        input.synthetic_node_id,
      );
      await input.emit(
        "cost.recorded",
        {
          provider: "stub",
          model: "stub-small",
          stop_reason: "stop",
          input_tokens: 42,
          output_tokens: 12,
          cost_usd: 0.00021,
        },
        input.synthetic_node_id,
      );
      await input.emit(
        "summary.completed",
        {
          purpose: input.purpose,
          provider: "stub",
          model: "stub-small",
          caller_node_id: input.caller_node_id,
          input_tokens: 42,
          output_tokens: 12,
          cost_usd: 0.00021,
          duration_ms: 7,
          output_text: this.output.text,
          ...(this.output.error !== undefined ? { error: this.output.error } : {}),
        },
        input.synthetic_node_id,
      );
    }
    return {
      text: this.output.text,
      ok: this.output.ok,
      ...(this.output.error !== undefined ? { error: this.output.error } : {}),
      provider: "stub",
      model: "stub-small",
      input_tokens: 42,
      output_tokens: 12,
      cost_usd: 0.00021,
      duration_ms: 7,
    };
  }
}

describe("summariser wiring — Wave 2b", () => {
  let scratch: string;
  let mockHandle: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-sum-"));
    mockHandle = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mockHandle.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("pipeline auto-title emits pipeline.title_generated under __summary.title", async () => {
    const summariser = new RecordingSummariser();
    summariser.output = { text: "Add list_dir tool", ok: true };
    mockHandle.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] t [prompt="hi", fidelity="full"] done [shape=Msquare] s -> t -> done }
    `);
    await execute({
      graph,
      sink,
      backend: mockHandle.backend,
      summariser,
      args: { $ARGUMENTS: "add a local:list_dir tool that lists files in a directory" },
    });

    expect(summariser.calls).toHaveLength(1);
    expect(summariser.calls[0]!.purpose).toBe("title");
    expect(summariser.calls[0]!.synthetic_node_id).toBe("__summary.title");

    const titleEvents = sink.byType("pipeline.title_generated");
    expect(titleEvents).toHaveLength(1);
    expect((titleEvents[0]!.data as { title: string }).title).toBe("Add list_dir tool");
    expect(titleEvents[0]!.node_id).toBe("__summary.title");

    // Summariser cost rides under the synthetic node — not attributed to
    // any real codergen node.
    const costs = sink.byType("cost.recorded").filter((e) => e.node_id === "__summary.title");
    expect(costs).toHaveLength(1);
  });

  test("auto_title=off short-circuits the title call", async () => {
    const summariser = new RecordingSummariser();
    mockHandle.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph { s [shape=Mdiamond] t [prompt="hi", fidelity="full"] done [shape=Msquare] s -> t -> done }
    `);
    await execute({
      graph,
      sink,
      backend: mockHandle.backend,
      summariser,
      auto_title: "off",
      args: { $ARGUMENTS: "something the user typed" },
    });
    expect(summariser.calls).toHaveLength(0);
    expect(sink.byType("pipeline.title_generated")).toHaveLength(0);
  });

  test("fidelity=summary:medium routes through the summariser under a caller-scoped synthetic node", async () => {
    const summariser = new RecordingSummariser();
    summariser.output = { text: "The agent earlier wrote hi.txt then verified.", ok: true };
    // Fresh backend wired to this summariser so we can prove the
    // summary:medium path actually invokes it.
    mockHandle.dispose();
    mockHandle = createPiMockBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: scratch }),
      summariser,
    });
    mockHandle.setResponses([
      fauxAssistantMessage("alpha response", { stopReason: "stop" }),
      fauxAssistantMessage("beta response", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        graph [goal="summary:medium wiring"]
        s [shape=Mdiamond]
        alpha [prompt="alpha q",  fidelity="full",           thread_id="dev"]
        beta  [prompt="beta q",   fidelity="summary:medium", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mockHandle.backend });

    // Exactly one summariser call — from beta, not alpha.
    const fidelityCalls = summariser.calls.filter((c) => c.purpose === "fidelity");
    expect(fidelityCalls).toHaveLength(1);
    expect(fidelityCalls[0]!.caller_node_id).toBe("beta");
    expect(fidelityCalls[0]!.synthetic_node_id).toBe("__summary.beta");
    expect(fidelityCalls[0]!.fidelity).toBe("summary:medium");

    // The LLM call for beta carries the summariser narrative inline, not a
    // deterministic role census.
    const betaLlm = sink.byType("llm.start").find((e) => e.node_id === "beta");
    expect(betaLlm).toBeDefined();
    const prompt = (betaLlm!.data as { prompt: string }).prompt;
    expect(prompt).toContain("The agent earlier wrote hi.txt then verified.");
    expect(prompt).toContain("<summariser-narrative>");

    // Cost lands under the synthetic node.
    const synthCosts = sink.byType("cost.recorded").filter((e) => e.node_id === "__summary.beta");
    expect(synthCosts).toHaveLength(1);
  });

  test("summariser failure on fidelity=summary:high falls back with a warning", async () => {
    const summariser = new RecordingSummariser();
    summariser.output = { text: "", ok: false, error: "network flake" };
    mockHandle.dispose();
    mockHandle = createPiMockBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: scratch }),
      summariser,
    });
    mockHandle.setResponses([
      fauxAssistantMessage("alpha", { stopReason: "stop" }),
      fauxAssistantMessage("beta", { stopReason: "stop" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        alpha [prompt="alpha", fidelity="full",         thread_id="dev"]
        beta  [prompt="beta",  fidelity="summary:high", thread_id="dev"]
        done  [shape=Msquare]
        s -> alpha -> beta -> done
      }
    `);
    await execute({ graph, sink, backend: mockHandle.backend });

    const warnings = sink.byType("agent.warning").map((e) => (e.data as { message?: string }).message ?? "");
    expect(warnings.some((w) => w.includes("summariser failed") && w.includes("network flake"))).toBe(true);
  });
});

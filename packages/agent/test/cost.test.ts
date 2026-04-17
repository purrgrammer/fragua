import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

describe("cost.recorded events", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-cost-"));
    mock = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("each assistant message_end emits a cost.recorded event", async () => {
    mock.setResponses([fauxAssistantMessage("hello", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="hi"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, backend: mock.backend, sink });

    const costs = sink.byType("cost.recorded");
    expect(costs).toHaveLength(1);
    const d = costs[0]!.data as {
      provider: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    };
    expect(typeof d.provider).toBe("string");
    expect(typeof d.model).toBe("string");
    expect(d.input_tokens).toBeGreaterThanOrEqual(0);
    expect(d.output_tokens).toBeGreaterThanOrEqual(0);
    // faux provider reports zero cost; ensures the field is present as a number
    expect(typeof d.cost_usd).toBe("number");
  });
});

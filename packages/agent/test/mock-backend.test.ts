import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import {
  createPiMockBackend,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type PiMockBackendHandle,
} from "../src/mock.ts";

describe("PiMockBackend — end-to-end with faux provider", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-mock-"));
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    mock = createPiMockBackend({
      registry,
      env: new LocalEnvironment({ cwd: scratch }),
    });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("scripted single-turn: writes greeting and terminates", async () => {
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall("local:write_file", { path: "hi.txt", contents: "hello swarm" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("wrote greeting", { stopReason: "stop" }),
    ]);

    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        write [prompt="Write a greeting to hi.txt"]
        done [shape=Msquare]
        s -> write -> done
      }
    `);

    const res = await execute({ graph, sink, backend: mock.backend });
    expect(res.outcome.status).toBe("success");
    expect(await readFile(join(scratch, "hi.txt"), "utf8")).toBe("hello swarm");
    // Event log should include the tool execution
    const types = sink.snapshot().map((e) => e.type);
    expect(types).toContain("tool.execution_start");
    expect(types).toContain("tool.execution_end");
  });

  test("error stopReason → fail outcome", async () => {
    mock.setResponses([
      fauxAssistantMessage([fauxText("boom")], { stopReason: "error", errorMessage: "scripted failure" }),
    ]);
    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [prompt="Fail please"]
        done [shape=Msquare]
        bad [shape=Msquare]
        s -> t
        t -> done [condition="outcome=success"]
        t -> bad [condition="outcome=fail"]
      }
    `);
    const res = await execute({ graph, sink, backend: mock.backend });
    expect(res.completed_nodes).toContain("bad");
    expect(res.node_outcomes["t"]!.status).toBe("fail");
  });
});

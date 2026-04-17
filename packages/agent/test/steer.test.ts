import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("PiCodergenBackend — steering file", () => {
  let scratch: string;
  let runsDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-steer-"));
    runsDir = join(scratch, ".swarm/runs");
    faux = registerFauxProvider();
  });

  afterEach(async () => {
    faux.unregister();
    await rm(scratch, { recursive: true, force: true });
  });

  test("backend picks up new lines in steering.jsonl and calls agent.steer()", async () => {
    const run_id = "test-run-steer";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const steeringFile = join(runDir, "steering.jsonl");

    // Pre-seed a steering message BEFORE the agent starts so the poller has
    // something to find immediately. (This also dodges race conditions.)
    await appendFile(
      steeringFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), message: "stop and reply" })}\n`,
      "utf8",
    );

    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage([fauxText("acknowledged")], { stopReason: "stop" })]);

    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: scratch });
    const backend = new PiCodergenBackend({
      registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      runsDir,
      steeringPollMs: 50,
    });

    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [shape=box, prompt="work"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);

    await execute({ graph, run_id, sink, backend });

    // The poller should have picked up the steering line and emitted an event
    const steerEvents = sink.byType("steering.injected");
    expect(steerEvents.length).toBeGreaterThanOrEqual(1);
    expect(steerEvents[0]!.data["message"]).toBe("stop and reply");
  });

  test("no runsDir configured → no poller, no events", async () => {
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage([fauxText("no steering here")], { stopReason: "stop" })]);

    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: scratch });
    const backend = new PiCodergenBackend({
      registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      // no runsDir
    });

    const sink = new InMemorySink();
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        t [shape=box, prompt="work"]
        done [shape=Msquare]
        s -> t -> done
      }
    `);
    await execute({ graph, run_id: "no-steer", sink, backend });
    expect(sink.byType("steering.injected").length).toBe(0);
  });
});

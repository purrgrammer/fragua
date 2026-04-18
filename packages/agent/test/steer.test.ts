// Steer via the control channel. The executor tails `control.jsonl`,
// mirrors requests to `events.jsonl` as `control.requested`, forwards
// `steer` commands to the backend's `steer()` hook, and emits
// `control.applied` on success. This replaces the legacy
// `steering.jsonl` poller that used to live inside the backend.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { tailControlRequests } from "@swarm/events";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("PiCodergenBackend — control channel (steer)", () => {
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

  test("pre-seeded steer request in control.jsonl is injected and emits paired control events", async () => {
    const run_id = "test-run-steer";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const controlFile = join(runDir, "control.jsonl");

    // Pre-seed a steer request BEFORE the agent starts. The executor's
    // control loop will read it synchronously on startup and forward to
    // the backend's steer() hook.
    await appendFile(
      controlFile,
      `${JSON.stringify({
        id: "ctl-1",
        timestamp: new Date().toISOString(),
        command: "steer",
        payload: { message: "stop and reply" },
      })}\n`,
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

    await execute({
      graph,
      run_id,
      sink,
      backend,
      controlChannel: { path: controlFile, tail: tailControlRequests },
    });

    const requested = sink.byType("control.requested");
    const applied = sink.byType("control.applied");
    expect(requested.length).toBeGreaterThanOrEqual(1);
    expect(requested[0]!.data["id"]).toBe("ctl-1");
    expect(requested[0]!.data["command"]).toBe("steer");
    expect(applied.length).toBeGreaterThanOrEqual(1);
    expect(applied[0]!.data["id"]).toBe("ctl-1");
    expect(applied[0]!.data["note"]).toBe("injected");
  });

  test("no controlChannel configured → no control events", async () => {
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
    expect(sink.byType("control.requested").length).toBe(0);
    expect(sink.byType("control.applied").length).toBe(0);
  });
});

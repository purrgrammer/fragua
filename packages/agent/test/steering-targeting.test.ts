// Control-channel targeting + robustness. Extends the basic steer test
// with scenarios that exercise error paths on the control.jsonl tail:
//
//   - Malformed JSON lines are ignored rather than crashing the loop.
//   - Requests missing the required `message` payload for steer are
//     skipped with a `control.rejected { reason: "missing_message" }`
//     event rather than silently dropped.
//   - Multiple pre-seeded requests each round-trip through
//     `control.requested` / `control.applied`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { tailControlRequests } from "@swarm/events";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("control channel — targeting + robustness", () => {
  let scratch: string;
  let runsDir: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-steer-tgt-"));
    runsDir = join(scratch, ".swarm/runs");
    faux = registerFauxProvider();
  });

  afterEach(async () => {
    faux.unregister();
    await rm(scratch, { recursive: true, force: true });
  });

  function buildBackend(): PiCodergenBackend {
    const model = faux.getModel();
    return new PiCodergenBackend({
      registry: new ToolRegistry(),
      env: new LocalEnvironment({ cwd: scratch }),
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
    });
  }

  test("malformed lines are ignored; missing-message requests are rejected; valid ones are applied", async () => {
    const run_id = "test-run-malformed";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const file = join(runDir, "control.jsonl");
    // Pre-seed: invalid JSON (skipped by parser), valid steer w/ empty
    // message (rejected by loop), valid steer with real message (applied).
    await appendFile(
      file,
      "this is not JSON at all\n" +
        `${JSON.stringify({
          id: "ctl-empty",
          timestamp: new Date().toISOString(),
          command: "steer",
          payload: {},
        })}\n` +
        `${JSON.stringify({
          id: "ctl-real",
          timestamp: new Date().toISOString(),
          command: "steer",
          payload: { message: "only real one" },
        })}\n`,
      "utf8",
    );

    faux.setResponses([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph { s [shape=Mdiamond] t [shape=box, prompt="hi"] done [shape=Msquare] s -> t -> done }
      `),
      run_id,
      sink,
      backend: buildBackend(),
      controlChannel: { path: file, tail: tailControlRequests },
    });
    const requested = sink.byType("control.requested");
    const applied = sink.byType("control.applied");
    const rejected = sink.byType("control.rejected");
    // Malformed line is skipped at parse time — no control.* event.
    expect(requested.map((e) => e.data["id"])).toEqual(["ctl-empty", "ctl-real"]);
    expect(applied.map((e) => e.data["id"])).toEqual(["ctl-real"]);
    expect(rejected.map((e) => e.data["id"])).toEqual(["ctl-empty"]);
    expect(rejected[0]!.data["reason"]).toBe("missing_message");
  });

  test("multiple pre-seeded steer requests each round-trip through applied", async () => {
    const run_id = "test-run-multi";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const file = join(runDir, "control.jsonl");
    await appendFile(
      file,
      `${JSON.stringify({
        id: "m1",
        timestamp: new Date().toISOString(),
        command: "steer",
        payload: { message: "one" },
      })}\n` +
        `${JSON.stringify({
          id: "m2",
          timestamp: new Date().toISOString(),
          command: "steer",
          payload: { message: "two" },
        })}\n` +
        `${JSON.stringify({
          id: "m3",
          timestamp: new Date().toISOString(),
          command: "steer",
          payload: { message: "three" },
        })}\n`,
      "utf8",
    );

    faux.setResponses([fauxAssistantMessage([fauxText("done")], { stopReason: "stop" })]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph { s [shape=Mdiamond] t [shape=box, prompt="hi"] done [shape=Msquare] s -> t -> done }
      `),
      run_id,
      sink,
      backend: buildBackend(),
      controlChannel: { path: file, tail: tailControlRequests },
    });
    expect(sink.byType("control.requested").map((e) => e.data["id"])).toEqual(["m1", "m2", "m3"]);
    expect(sink.byType("control.applied").map((e) => e.data["id"])).toEqual(["m1", "m2", "m3"]);
  });
});

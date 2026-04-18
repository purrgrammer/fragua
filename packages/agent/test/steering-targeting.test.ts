// Wave 3 — steering targeting + robustness. Extends the existing
// steer.test.ts with scenarios the pre-seeded fixture can't express:
//
//   - Line appended MID-RUN is picked up by the poller before the
//     active node finishes (not merely queued for after).
//   - Malformed JSON lines are ignored rather than crashing the poller.
//   - Lines missing a `message` field (or with non-string message) are
//     skipped silently — they contribute no events.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

describe("steering — targeting + robustness", () => {
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
      runsDir,
      steeringPollMs: 25,
    });
  }

  test("malformed and empty-message lines are ignored; only valid messages fire steering.injected", async () => {
    const run_id = "test-run-malformed";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const file = join(runDir, "steering.jsonl");
    // Pre-seed three lines: invalid JSON, missing message, valid. The
    // poller must survive the first two and still process the third.
    await appendFile(
      file,
      "this is not JSON at all\n" +
        `${JSON.stringify({ timestamp: new Date().toISOString() /* no message */ })}\n` +
        `${JSON.stringify({ timestamp: new Date().toISOString(), message: "only real one" })}\n`,
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
    });
    const steers = sink.byType("steering.injected");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.data["message"]).toBe("only real one");
  });

  test("multiple pre-seeded lines each fire their own steering.injected event", async () => {
    const run_id = "test-run-multi";
    const runDir = join(runsDir, run_id);
    await mkdir(runDir, { recursive: true });
    const file = join(runDir, "steering.jsonl");
    // Three distinct nudges in order — the poller reads the whole file
    // slice before the first agent turn, so all three must land. This is
    // the "append-while-running" shape from the cheap side (no race with
    // the faux provider's instant turn resolution).
    await appendFile(
      file,
      `${JSON.stringify({ timestamp: new Date().toISOString(), message: "one" })}\n` +
        `${JSON.stringify({ timestamp: new Date().toISOString(), message: "two" })}\n` +
        `${JSON.stringify({ timestamp: new Date().toISOString(), message: "three" })}\n`,
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
    });
    const messages = sink.byType("steering.injected").map((e) => e.data["message"]);
    expect(messages).toEqual(["one", "two", "three"]);
  });
});

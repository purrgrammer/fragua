// Integration test for `createFsControlGateway` — verifies the adapter
// actually writes valid `ControlRequest` lines to the expected path
// and honors 404 semantics against a memory-backed RunReader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsControlGateway } from "../src/adapters/fs-control-gateway.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("createFsControlGateway", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "swarm-gateway-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  test("steer writes a ControlRequest line with uuid id to <runsDir>/<runId>/control.jsonl", async () => {
    const runReader = memoryRunReader({ r1: [ev({ type: "pipeline.started" })] });
    const gw = createFsControlGateway({ runsDir, runReader });
    const result = await gw.steer("r1", "hi");
    expect(result.ok).toBe(true);

    const file = join(runsDir, "r1", "control.jsonl");
    const contents = (await readFile(file, "utf8")).trim();
    const line = JSON.parse(contents);
    expect(line.command).toBe("steer");
    expect(line.payload?.message).toBe("hi");
    expect(line.id).toMatch(/^[0-9a-f-]{36}$/i);
    if (result.ok) expect(line.id).toBe(result.id);
  });

  test("pause/resume/cancel each write a single line with the right command", async () => {
    const runReader = memoryRunReader({ r1: [ev({ type: "pipeline.started" })] });
    const gw = createFsControlGateway({ runsDir, runReader });
    await gw.pause("r1", "step out");
    await gw.resume("r1");
    await gw.cancel("r1");
    const file = join(runsDir, "r1", "control.jsonl");
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    const [a, b, c] = lines as [string, string, string];
    expect(JSON.parse(a).command).toBe("pause");
    expect(JSON.parse(a).payload?.reason).toBe("step out");
    expect(JSON.parse(b).command).toBe("resume");
    expect(JSON.parse(c).command).toBe("cancel");
  });

  test("unknown run → not_found, no file created", async () => {
    const runReader = memoryRunReader({}); // empty archive
    const gw = createFsControlGateway({ runsDir, runReader });
    const result = await gw.steer("ghost", "hi");
    expect(result).toEqual({ ok: false, code: "not_found" });
    // and nothing was written
    try {
      await readFile(join(runsDir, "ghost", "control.jsonl"), "utf8");
      throw new Error("expected ENOENT");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

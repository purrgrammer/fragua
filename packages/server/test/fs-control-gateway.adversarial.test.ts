// Adversarial tests for the filesystem control gateway. Complements
// the base test file with edge cases that matter in production:
//
//   - concurrent writes (steer + cancel to the same run at once)
//   - large payloads survive the round-trip
//   - bogus/empty messages route to the expected reject/bad path
//   - pre-existing control.jsonl from a prior run doesn't get clobbered

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsControlGateway } from "../src/adapters/fs-control-gateway.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("fs control gateway — adversarial", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "swarm-gw-adv-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  test("20 concurrent submissions: every line is valid JSON with a unique id", async () => {
    const runReader = memoryRunReader({ r1: [ev({ type: "pipeline.started" })] });
    const gw = createFsControlGateway({ runsDir, runReader });

    // Mix of commands fired in parallel. appendFile is atomic at the
    // line boundary on POSIX for <PIPE_BUF writes, so no torn lines.
    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      ops.push(
        i % 4 === 0
          ? gw.steer("r1", `msg-${i}`)
          : i % 4 === 1
            ? gw.pause("r1")
            : i % 4 === 2
              ? gw.resume("r1")
              : gw.cancel("r1"),
      );
    }
    const results = await Promise.all(ops);
    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);

    const contents = await readFile(join(runsDir, "r1", "control.jsonl"), "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(20);

    const ids = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed.id).toBe("string");
      expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(typeof parsed.timestamp).toBe("string");
      expect(["steer", "pause", "resume", "cancel"]).toContain(parsed.command);
      ids.add(parsed.id);
    }
    expect(ids.size).toBe(20);
  });

  test("large steer payload is preserved verbatim", async () => {
    const runReader = memoryRunReader({ r1: [ev({ type: "pipeline.started" })] });
    const gw = createFsControlGateway({ runsDir, runReader });

    const big = "x".repeat(16_000); // well over PIPE_BUF
    const result = await gw.steer("r1", big);
    expect(result.ok).toBe(true);

    const line = (await readFile(join(runsDir, "r1", "control.jsonl"), "utf8")).trim();
    const parsed = JSON.parse(line);
    expect(parsed.payload.message).toBe(big);
    expect(parsed.payload.message.length).toBe(16_000);
  });

  test("appends to a pre-existing control.jsonl without clobbering prior lines", async () => {
    // Simulate a prior daemon run that left a line behind. The new
    // gateway must append, not truncate.
    await mkdir(join(runsDir, "r1"), { recursive: true });
    const pre = `${JSON.stringify({
      id: "prior-run-id",
      timestamp: "2026-01-01T00:00:00Z",
      command: "steer",
      payload: { message: "from-before" },
    })}\n`;
    await appendFile(join(runsDir, "r1", "control.jsonl"), pre);

    const runReader = memoryRunReader({ r1: [ev({ type: "pipeline.started" })] });
    const gw = createFsControlGateway({ runsDir, runReader });
    await gw.pause("r1");

    const lines = (await readFile(join(runsDir, "r1", "control.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe("prior-run-id");
    expect(JSON.parse(lines[1]!).command).toBe("pause");
  });

  test("unknown runId: all four commands return not_found and create no files", async () => {
    const runReader = memoryRunReader({});
    const gw = createFsControlGateway({ runsDir, runReader });

    for (const r of [
      await gw.steer("ghost", "hi"),
      await gw.pause("ghost"),
      await gw.resume("ghost"),
      await gw.cancel("ghost"),
    ]) {
      expect(r).toEqual({ ok: false, code: "not_found" });
    }

    // No `ghost` subdir created.
    try {
      await readFile(join(runsDir, "ghost", "control.jsonl"), "utf8");
      throw new Error("expected ENOENT");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

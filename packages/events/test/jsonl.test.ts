import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { JsonlSink, readJsonlEvents } from "../src/jsonl.ts";

function makeEvent(partial: Partial<Event>): Event {
  return {
    run_id: "r1",
    type: "node.started",
    timestamp: "2026-01-01T00:00:00Z",
    workflow_sha: "abc",
    data: {},
    ...partial,
  };
}

describe("JsonlSink", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-jsonl-"));
    file = join(dir, "runs", "abc", "events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("appends events as JSONL and round-trips via readJsonlEvents", async () => {
    const sink = new JsonlSink({ filePath: file });
    await sink.append(makeEvent({ node_id: "n1" }));
    await sink.append(makeEvent({ node_id: "n2", type: "node.completed" }));
    await sink.close();

    const events = await readJsonlEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0]!.node_id).toBe("n1");
    expect(events[1]!.type).toBe("node.completed");
  });

  test("creates parent directories on first append", async () => {
    const sink = new JsonlSink({ filePath: file });
    await sink.append(makeEvent({}));
    await sink.close();
    const events = await readJsonlEvents(file);
    expect(events).toHaveLength(1);
  });

  test("preserves event order across many appends", async () => {
    const sink = new JsonlSink({ filePath: file });
    for (let i = 0; i < 50; i++) {
      await sink.append(makeEvent({ node_id: `n${i}` }));
    }
    await sink.close();
    const events = await readJsonlEvents(file);
    expect(events.map((e) => e.node_id)).toEqual(Array.from({ length: 50 }, (_, i) => `n${i}`));
  });
});

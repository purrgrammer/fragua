// Integration test for GET /pipelines/:runId/events.
//
// Strategy: don't bind to a port — Hono's `app.request()` gives us a Response
// whose body is the live ReadableStream. We parse SSE frames off it directly,
// append to the underlying JSONL, and assert on the sequence of frames.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { createServer } from "../src/index.ts";

function ev(nodeId: string, type: Event["type"] = "node.started"): Event {
  return {
    run_id: "r1",
    node_id: nodeId,
    type,
    timestamp: "2026-01-01T00:00:00Z",
    workflow_sha: "abc",
    data: {},
  };
}

function line(e: Event): string {
  return `${JSON.stringify(e)}\n`;
}

interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Read SSE frames from a ReadableStream until `want` frames are buffered OR
 * the `signal` aborts. Returns after each frame so callers can drive
 * additional writes in between.
 */
async function readFrames(stream: ReadableStream<Uint8Array>, want: number, signal: AbortSignal): Promise<Frame[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];

  const onAbort = () => {
    // Cancel the underlying stream so the server's tail loop unwinds.
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (frames.length < want && !signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line (\n\n).
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(raw);
        if (parsed) frames.push(parsed);
        if (frames.length >= want) break;
        sep = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return frames;
}

function parseFrame(raw: string): Frame | undefined {
  const out: Frame = { data: "" };
  const dataLines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    if (rawLine.startsWith(":")) continue; // comment
    const idx = rawLine.indexOf(":");
    if (idx < 0) continue;
    const field = rawLine.slice(0, idx);
    // Per spec, a single optional space after the colon is stripped.
    const value = rawLine.slice(idx + 1).replace(/^ /, "");
    if (field === "data") dataLines.push(value);
    else if (field === "event") out.event = value;
    else if (field === "id") out.id = value;
  }
  if (dataLines.length === 0) return undefined;
  out.data = dataLines.join("\n");
  return out;
}

describe("GET /pipelines/:runId/events (SSE)", () => {
  let dir: string;
  let runsDir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-server-"));
    runsDir = join(dir, "runs");
    await mkdir(join(runsDir, "r1"), { recursive: true });
    file = join(runsDir, "r1", "events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("replays existing events and streams new appends", async () => {
    await writeFile(file, line(ev("a")) + line(ev("b")));
    const app = createServer({ runsDir });

    const res = await app.request("/pipelines/r1/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(res.body).toBeDefined();

    const ac = new AbortController();
    // Drive the append concurrently so our reader can see it live.
    const pending = readFrames(res.body as ReadableStream<Uint8Array>, 3, ac.signal);
    // Give the server a chance to flush the replay before we append.
    await Bun.sleep(50);
    await appendFile(file, line(ev("c", "node.completed")));

    const frames = await withTimeout(pending, 2000);
    ac.abort();

    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.id)).toEqual(["1", "2", "3"]);
    expect(frames[0]!.event).toBe("node.started");
    expect(frames[2]!.event).toBe("node.completed");
    const parsed0 = JSON.parse(frames[0]!.data) as Event;
    const parsed2 = JSON.parse(frames[2]!.data) as Event;
    expect(parsed0.node_id).toBe("a");
    expect(parsed2.node_id).toBe("c");
  });

  test("Last-Event-ID skips already-delivered events on reconnect", async () => {
    await writeFile(file, line(ev("a")) + line(ev("b")) + line(ev("c")));
    const app = createServer({ runsDir });

    const res = await app.request("/pipelines/r1/events", {
      headers: { "Last-Event-ID": "2" },
    });
    expect(res.status).toBe(200);

    const ac = new AbortController();
    const pending = readFrames(res.body as ReadableStream<Uint8Array>, 1, ac.signal);
    const frames = await withTimeout(pending, 2000);
    ac.abort();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe("3");
    expect((JSON.parse(frames[0]!.data) as Event).node_id).toBe("c");
  });

  test("returns 404 for an unknown run", async () => {
    const app = createServer({ runsDir });
    const res = await app.request("/pipelines/does-not-exist/events");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("run not found");
  });

  test("client disconnect tears down the watcher", async () => {
    await writeFile(file, line(ev("a")));
    const app = createServer({ runsDir });

    const res = await app.request("/pipelines/r1/events");
    const ac = new AbortController();
    const pending = readFrames(res.body as ReadableStream<Uint8Array>, 1, ac.signal);
    const frames = await withTimeout(pending, 2000);
    expect(frames).toHaveLength(1);

    // Cancel: server's tail should observe the abort and exit. If it didn't,
    // subsequent test runs would leak watchers; Bun would surface the leak.
    ac.abort();
    await Bun.sleep(20);
    // No assertion beyond "this didn't hang" — cleanup is verified by the
    // afterEach rm and the test suite finishing.
  });

  test("GET /health returns ok", async () => {
    const app = createServer({ runsDir });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { tailJsonl } from "../src/tail.ts";

function ev(node_id: string, type: Event["type"] = "node.started"): Event {
  return {
    run_id: "r1",
    node_id,
    type,
    timestamp: "2026-01-01T00:00:00Z",
    workflow_sha: "abc",
    data: {},
  };
}

function toLine(e: Event): string {
  return `${JSON.stringify(e)}\n`;
}

describe("tailJsonl", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-tail-"));
    file = join(dir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("yields existing lines then appended ones until aborted", async () => {
    await writeFile(file, toLine(ev("a")) + toLine(ev("b")));
    const ac = new AbortController();
    const out: Event[] = [];

    const pump = (async () => {
      for await (const e of tailJsonl(file, { signal: ac.signal })) {
        out.push(e);
        if (out.length === 4) ac.abort();
      }
    })();

    // Allow the iterator to drain the pre-seeded lines and install the watcher.
    await Bun.sleep(50);
    await appendFile(file, toLine(ev("c")));
    await Bun.sleep(30);
    await appendFile(file, toLine(ev("d")));

    await pump;
    expect(out.map((e) => e.node_id)).toEqual(["a", "b", "c", "d"]);
  });

  test("skips malformed lines without aborting the stream", async () => {
    await writeFile(file, `${toLine(ev("a"))}not-json\n${toLine(ev("b"))}`);
    const ac = new AbortController();
    const out: Event[] = [];

    const pump = (async () => {
      for await (const e of tailJsonl(file, { signal: ac.signal })) {
        out.push(e);
        if (out.length === 2) ac.abort();
      }
    })();

    await pump;
    expect(out.map((e) => e.node_id)).toEqual(["a", "b"]);
  });

  test("file truncated mid-tail → resets and yields new content", async () => {
    // Two existing events, then the file gets nuked to empty (rotation / clear /
    // editor save), then a new event is appended. The tail must not stall.
    await writeFile(file, toLine(ev("a")) + toLine(ev("b")));
    const ac = new AbortController();
    const out: Event[] = [];

    const pump = (async () => {
      for await (const e of tailJsonl(file, { signal: ac.signal })) {
        out.push(e);
        if (out.length === 3) ac.abort();
      }
    })();

    await Bun.sleep(50); // let initial replay drain
    await writeFile(file, ""); // truncate
    await Bun.sleep(30);
    await appendFile(file, toLine(ev("c")));

    await pump;
    expect(out.map((e) => e.node_id)).toEqual(["a", "b", "c"]);
  });

  test("includeExisting=false starts at EOF", async () => {
    await writeFile(file, toLine(ev("pre1")) + toLine(ev("pre2")));
    const ac = new AbortController();
    const out: Event[] = [];

    const pump = (async () => {
      for await (const e of tailJsonl(file, { signal: ac.signal, includeExisting: false })) {
        out.push(e);
        if (out.length === 1) ac.abort();
      }
    })();

    await Bun.sleep(50);
    await appendFile(file, toLine(ev("new")));

    await pump;
    expect(out.map((e) => e.node_id)).toEqual(["new"]);
  });
});

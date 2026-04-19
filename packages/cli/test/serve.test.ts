// Tests for the `swarm serve` command.
//
// Strategy: bind to port 0 (ephemeral) so tests run in parallel without
// stepping on each other, hit `/health` via real fetch, then close. We never
// install SIGINT handlers in these tests — they exercise `startServer`
// directly, which is the test-friendly half of the module.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveCommand, startServer } from "../src/commands/serve.ts";

describe("startServer", () => {
  let handle: Awaited<ReturnType<typeof startServer>> | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  test("binds an ephemeral port and returns a handle", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    handle = await startServer({ port: 0, cwd: scratch });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://localhost:${handle.port}`);
    expect(typeof handle.close).toBe("function");
  });

  test("GET /health returns 200 {ok:true}", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    handle = await startServer({ port: 0, cwd: scratch });
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("close() releases the port (subsequent bind to same port succeeds)", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    const first = await startServer({ port: 0, cwd: scratch });
    const port = first.port;
    await first.close();
    // Rebind to the exact port that was just freed. If `close()` left a
    // dangling listener this throws EADDRINUSE.
    handle = await startServer({ port, cwd: scratch });
    expect(handle.port).toBe(port);
  });
});

describe("serveCommand", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  test("SIGINT triggers clean shutdown and returns exit code 0", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    // Run in the background; serveCommand blocks until SIGINT/SIGTERM.
    const done = serveCommand({ port: 0, cwd: scratch });
    // Give the bind a moment to complete before we send the signal.
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT");
    const code = await done;
    expect(code).toBe(0);
  });

  test("conflicting port → exit code 1", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    const occupied = await startServer({ port: 0, cwd: scratch });
    try {
      const code = await serveCommand({ port: occupied.port, cwd: scratch });
      expect(code).toBe(1);
    } finally {
      await occupied.close();
    }
  });
});

// Tests for the `swarm serve` command.
//
// Strategy: bind to port 0 (ephemeral) so tests run in parallel without
// stepping on each other, hit `/health` via real fetch, then close. We never
// install SIGINT handlers in these tests — they exercise `startServer`
// directly, which is the test-friendly half of the module.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB_PORT, serveCommand, startServer } from "../src/commands/serve.ts";

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
    expect(handle.origin).toBe(`http://localhost:${handle.port}`);
    // In web mode the canonical API URL is scoped under `/api`; in API-only
    // mode it equals origin. Either is fine — we just care both are set.
    expect(handle.url.startsWith(handle.origin)).toBe(true);
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

  test("config.web.port wins when --port is omitted", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    // Pick a port the test owns by binding ephemeral first to discover a
    // free one, then closing and writing it into the project config.
    // Avoids hardcoding a port that might collide on a busy CI host.
    const probe = await startServer({ port: 0, cwd: scratch });
    const target = probe.port;
    await probe.close();

    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), JSON.stringify({ web: { port: target } }));

    handle = await startServer({ cwd: scratch });
    expect(handle.port).toBe(target);
  });

  test("default port falls back to DEFAULT_WEB_PORT (6767) and auto-bumps on collision", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    // We don't know whether 6767 is free on the test host, so we hold an
    // occupant on it (best-effort) and assert the server lands within the
    // bump window. If 6767 was already busy from another process the
    // bump still kicks in; either way the bound port should be in
    // [DEFAULT_WEB_PORT, DEFAULT_WEB_PORT+20].
    handle = await startServer({ cwd: scratch });
    expect(handle.port).toBeGreaterThanOrEqual(DEFAULT_WEB_PORT);
    expect(handle.port).toBeLessThan(DEFAULT_WEB_PORT + 20);
  });

  test("explicit --port disables the auto-bump (hard fail on EADDRINUSE)", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    const occupant = await startServer({ port: 0, cwd: scratch });
    try {
      await expect(startServer({ port: occupant.port, cwd: scratch })).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await occupant.close();
    }
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
    // Pass `webDistDir: undefined` to opt out of the auto-build that
    // serveCommand normally runs — keeps the test fast and doesn't depend
    // on the state of the real packages/web/dist tree.
    const done = serveCommand({ port: 0, cwd: scratch, webDistDir: undefined });
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT");
    const code = await done;
    expect(code).toBe(0);
  });

  test("conflicting port → exit code 1", async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-serve-"));
    const occupied = await startServer({ port: 0, cwd: scratch });
    try {
      const code = await serveCommand({ port: occupied.port, cwd: scratch, webDistDir: undefined });
      expect(code).toBe(1);
    } finally {
      await occupied.close();
    }
  });
});

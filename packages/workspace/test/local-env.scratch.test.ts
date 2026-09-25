import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";

const KEY = { runId: "run-scratch-test", nodeId: "collect", iteration: 0 };
const NEVER_ABORT = new AbortController().signal;

describe("LocalEnvironment.createScratchFile", () => {
  let cwd: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "fragua-scratch-cwd-"));
    env = new LocalEnvironment({ cwd });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(join(tmpdir(), "fragua-scratch", KEY.runId), { recursive: true, force: true });
  });

  test("allocates a scratch path outside cwd and reads back an in-place write", async () => {
    const scratch = await env.createScratchFile(KEY);
    try {
      expect(scratch.path.startsWith(cwd)).toBe(false);
      await env.exec(`printf '{"x":1}' > "$FRAGUA_OUTPUT"`, { env: { FRAGUA_OUTPUT: scratch.path } });
      const r = await scratch.read(1024, NEVER_ABORT);
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(JSON.parse(r.text)).toEqual({ x: 1 });
    } finally {
      await scratch.dispose();
    }
  });

  test("returns absent when the process writes nothing", async () => {
    const scratch = await env.createScratchFile(KEY);
    try {
      await env.exec(`true`, { env: { FRAGUA_OUTPUT: scratch.path } });
      expect((await scratch.read(1024, NEVER_ABORT)).kind).toBe("absent");
    } finally {
      await scratch.dispose();
    }
  });

  test("returns oversize without exceeding the cap", async () => {
    const scratch = await env.createScratchFile(KEY);
    try {
      await env.exec(`head -c 200 /dev/zero > "$FRAGUA_OUTPUT"`, { env: { FRAGUA_OUTPUT: scratch.path } });
      expect((await scratch.read(50, NEVER_ABORT)).kind).toBe("oversize");
    } finally {
      await scratch.dispose();
    }
  });

  test("returns renamed when the child atomic-renames a temp file over the path", async () => {
    const scratch = await env.createScratchFile(KEY);
    try {
      await env.exec(`printf '{"x":1}' > "$FRAGUA_OUTPUT.tmp" && mv "$FRAGUA_OUTPUT.tmp" "$FRAGUA_OUTPUT"`, {
        env: { FRAGUA_OUTPUT: scratch.path },
      });
      expect((await scratch.read(1024, NEVER_ABORT)).kind).toBe("renamed");
    } finally {
      await scratch.dispose();
    }
  });

  test("stays absent (not a DoS) when the child symlinks /dev/zero onto the path", async () => {
    const scratch = await env.createScratchFile(KEY);
    try {
      await env.exec(`rm -f "$FRAGUA_OUTPUT" && ln -sf /dev/zero "$FRAGUA_OUTPUT"`, {
        env: { FRAGUA_OUTPUT: scratch.path },
      });
      expect((await scratch.read(1024, NEVER_ABORT)).kind).toBe("absent");
    } finally {
      await scratch.dispose();
    }
  });

  test("a re-allocation at the same key clears a leaked prior attempt and starts empty", async () => {
    // A leaked prior attempt's file at the deterministic path (a SIGKILLed
    // daemon that never disposed). The next allocation at the same key
    // unlink-then-creates a fresh empty inode, so a re-run never reads stale bytes.
    const staleDir = join(tmpdir(), "fragua-scratch", KEY.runId);
    await mkdir(staleDir, { recursive: true });
    const stalePath = join(staleDir, `${KEY.nodeId}-${KEY.iteration}`);
    const handle = await open(stalePath, "w");
    await handle.writeFile('{"stale":true}');
    await handle.close();
    const scratch = await env.createScratchFile(KEY);
    try {
      expect((await stat(scratch.path)).size).toBe(0);
      expect((await scratch.read(1024, NEVER_ABORT)).kind).toBe("absent");
    } finally {
      await scratch.dispose();
    }
  });

  test("dispose() closes the fd and unlinks; second dispose is a no-op", async () => {
    const scratch = await env.createScratchFile(KEY);
    await scratch.dispose();
    let existed = true;
    try {
      await stat(scratch.path);
    } catch {
      existed = false;
    }
    expect(existed).toBe(false);
    await scratch.dispose();
  });
});

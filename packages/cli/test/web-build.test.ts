// Tests the staleness-detection logic in ensureWebBundle without
// actually spawning vite — the build callback is injected and the
// helper's path/mtime decisions are exercised against a tmpdir.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWebBundle } from "../src/web-build.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
  delete process.env["FRAGUA_NO_WEB_BUILD"];
});

async function setup(opts: { withSrc?: boolean; withDist?: boolean; distMtime?: number } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fragua-web-build-"));
  if (opts.withSrc !== false) {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "main.tsx"), "// dummy");
  }
  if (opts.withDist) {
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "index.html"), "<html />");
    if (opts.distMtime !== undefined) {
      const ts = new Date(opts.distMtime);
      await utimes(join(root, "dist", "index.html"), ts, ts);
    }
  }
  return root;
}

describe("ensureWebBundle", () => {
  test("no source dir: reports no-source, returns existing dist if present", async () => {
    scratch = await setup({ withSrc: false, withDist: true });
    const r = await ensureWebBundle({ webPackageDir: scratch, verbose: false });
    expect(r.reason).toBe("no-source");
    expect(r.built).toBe(false);
    expect(r.distDir).toBe(join(scratch, "dist"));
  });

  test("no source AND no dist: API-only signal", async () => {
    scratch = await setup({ withSrc: false, withDist: false });
    const r = await ensureWebBundle({ webPackageDir: scratch, verbose: false });
    expect(r.reason).toBe("no-source");
    expect(r.distDir).toBeUndefined();
  });

  test("FRAGUA_NO_WEB_BUILD=1 short-circuits even with stale source", async () => {
    scratch = await setup({ withSrc: true, withDist: true, distMtime: 0 });
    process.env["FRAGUA_NO_WEB_BUILD"] = "1";
    let buildCalls = 0;
    const r = await ensureWebBundle({
      webPackageDir: scratch,
      verbose: false,
      runBuild: async () => {
        buildCalls++;
        return true;
      },
    });
    expect(r.reason).toBe("skipped-env");
    expect(buildCalls).toBe(0);
  });

  test("dist missing → built-missing, runs build", async () => {
    scratch = await setup({ withSrc: true, withDist: false });
    let buildCwd: string | undefined;
    const r = await ensureWebBundle({
      webPackageDir: scratch,
      verbose: false,
      runBuild: async (cwd) => {
        buildCwd = cwd;
        return true;
      },
    });
    expect(r.reason).toBe("built-missing");
    expect(r.built).toBe(true);
    expect(buildCwd).toBe(scratch);
  });

  test("dist newer than src → fresh, no build", async () => {
    scratch = await setup({ withSrc: true, withDist: true, distMtime: Date.now() + 60_000 });
    let buildCalls = 0;
    const r = await ensureWebBundle({
      webPackageDir: scratch,
      verbose: false,
      runBuild: async () => {
        buildCalls++;
        return true;
      },
    });
    expect(r.reason).toBe("fresh");
    expect(buildCalls).toBe(0);
  });

  test("src newer than dist → rebuilt-stale, runs build", async () => {
    // dist mtime in the distant past so any src touch beats it.
    scratch = await setup({ withSrc: true, withDist: true, distMtime: 1_000_000 });
    let buildCalls = 0;
    const r = await ensureWebBundle({
      webPackageDir: scratch,
      verbose: false,
      runBuild: async () => {
        buildCalls++;
        return true;
      },
    });
    expect(r.reason).toBe("rebuilt-stale");
    expect(r.built).toBe(true);
    expect(buildCalls).toBe(1);
  });

  test("build failure preserves any existing dist for fallback serving", async () => {
    scratch = await setup({ withSrc: true, withDist: true, distMtime: 1_000_000 });
    const r = await ensureWebBundle({
      webPackageDir: scratch,
      verbose: false,
      runBuild: async () => false,
    });
    expect(r.reason).toBe("build-failed");
    expect(r.built).toBe(false);
    expect(r.distDir).toBe(join(scratch, "dist"));
  });
});

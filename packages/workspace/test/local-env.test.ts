import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile as fsWriteFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment, PathEscapeError } from "../src/local-env.ts";

describe("LocalEnvironment", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "fragua-env-"));
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("writeFile then readFile round-trips content", async () => {
    await env.writeFile("hello.txt", "hi there");
    expect(await env.readFile("hello.txt")).toBe("hi there");
  });

  test("writeFile creates parent directories", async () => {
    await env.writeFile("a/b/c/deep.txt", "nested");
    expect(await env.readFile("a/b/c/deep.txt")).toBe("nested");
  });

  test("exists returns true/false correctly", async () => {
    expect(await env.exists("nope.txt")).toBe(false);
    await env.writeFile("yep.txt", "x");
    expect(await env.exists("yep.txt")).toBe(true);
  });

  test("exec captures stdout + stderr + exit code", async () => {
    const r = await env.exec("echo hello; echo err 1>&2; exit 3");
    expect(r.stdout).toContain("hello");
    expect(r.stderr).toContain("err");
    expect(r.exitCode).toBe(3);
  });

  test("exec timeout kills the process", async () => {
    const r = await env.exec("sleep 5", { timeoutMs: 200 });
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toContain("timed out");
  }, 5_000);

  describe("path-escape isolation", () => {
    test("writeFile throws PathEscapeError on absolute path outside cwd", async () => {
      const outside = join(tmpdir(), "fragua-escape-target.txt");
      await expect(env.writeFile(outside, "leak")).rejects.toBeInstanceOf(PathEscapeError);
    });

    test("writeFile throws PathEscapeError on `../` traversal escaping cwd", async () => {
      await expect(env.writeFile("../escape.txt", "leak")).rejects.toBeInstanceOf(PathEscapeError);
    });

    test("readFile throws PathEscapeError on absolute path outside cwd", async () => {
      const outside = join(tmpdir(), "fragua-escape-read.txt");
      await expect(env.readFile(outside)).rejects.toBeInstanceOf(PathEscapeError);
    });

    test("exists throws PathEscapeError on out-of-cwd path", async () => {
      const outside = join(tmpdir(), "fragua-escape-exists.txt");
      expect(() => env.exists(outside)).toThrow(PathEscapeError);
    });

    test("paths inside cwd still work", async () => {
      const absoluteInside = join(scratch, "ok.txt");
      await env.writeFile(absoluteInside, "yes");
      expect(await env.readFile("ok.txt")).toBe("yes");
    });

    test("exec refuses `cd <abs-path-outside-cwd>` with exitCode 126", async () => {
      const r = await env.exec("cd /tmp && echo escaped");
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toContain("escapes the run's cwd");
      expect(r.stdout).toBe("");
    });

    test("exec allows `cd` to a subdir inside cwd", async () => {
      await env.writeFile("sub/file.txt", "x");
      const r = await env.exec(`cd ${join(scratch, "sub")} && pwd`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("sub");
    });

    test("exec without `cd` runs in env's cwd by default", async () => {
      // pwd resolves symlinks (macOS /var → /private/var); just assert
      // the scratch dir name is in the output.
      const r = await env.exec("pwd");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("fragua-env-");
    });

    test("writeFile through a symlink inside cwd that targets outside throws PathEscapeError", async () => {
      const outside = await mkdtemp(join(tmpdir(), "fragua-escape-target-"));
      try {
        await symlink(outside, join(scratch, "linked"));
        await expect(env.writeFile("linked/leak.txt", "data")).rejects.toBeInstanceOf(PathEscapeError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    test("readFile through a symlink inside cwd that targets outside throws PathEscapeError", async () => {
      const outside = await mkdtemp(join(tmpdir(), "fragua-escape-read-"));
      try {
        await fsWriteFile(join(outside, "secret.txt"), "leaked");
        await symlink(outside, join(scratch, "linked"));
        await expect(env.readFile("linked/secret.txt")).rejects.toBeInstanceOf(PathEscapeError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    test("symlink file inside cwd that targets outside throws PathEscapeError on read", async () => {
      const outside = await mkdtemp(join(tmpdir(), "fragua-escape-file-"));
      try {
        await fsWriteFile(join(outside, "secret.txt"), "leaked");
        await symlink(join(outside, "secret.txt"), join(scratch, "shortcut"));
        await expect(env.readFile("shortcut")).rejects.toBeInstanceOf(PathEscapeError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("envDenyNames", () => {
    const TEST_VAR = "MY_SECRET_TOKEN";
    const TEST_VAR_VALUE = "leak-canary-value-xyz";
    let savedVars: Record<string, string | undefined>;

    beforeEach(() => {
      savedVars = {};
      for (const k of [TEST_VAR, "PUBLIC_VAR_NOTASECRET", "DENY_ME"] as const) {
        savedVars[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(savedVars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    test("(a) deny-listed var is absent from the spawned subprocess env", async () => {
      process.env[TEST_VAR] = TEST_VAR_VALUE;
      const denyEnv = new LocalEnvironment({
        cwd: scratch,
        envDenyNames: new Set([TEST_VAR]),
      });
      const r = await denyEnv.exec(`echo "X=${"$"}{${TEST_VAR}:-MISSING}"`);
      expect(r.stdout).toContain("X=MISSING");
      expect(r.stdout).not.toContain(TEST_VAR_VALUE);
    });

    test("(b) non-denied vars stay visible — PATH is intact, opts.env extras pass through", async () => {
      const denyEnv = new LocalEnvironment({
        cwd: scratch,
        envDenyNames: new Set([TEST_VAR]),
      });
      const r = await denyEnv.exec("echo P=$PATH F=${FOO:-NONE}", { env: { FOO: "bar" } });
      expect(r.stdout).toContain("F=bar");
      expect(r.stdout).toMatch(/P=[^/\s]*\//);
    });

    test("(b') opts.env leak of a deny-listed name is also stripped (delete-after-merge)", async () => {
      const denyEnv = new LocalEnvironment({
        cwd: scratch,
        envDenyNames: new Set(["DENY_ME"]),
      });
      const r = await denyEnv.exec("echo D=${DENY_ME:-GONE}", { env: { DENY_ME: "should-not-survive" } });
      expect(r.stdout).toContain("D=GONE");
      expect(r.stdout).not.toContain("should-not-survive");
    });

    test("(c) default LocalEnvironment (no envDenyNames) inherits the full env", async () => {
      process.env["PUBLIC_VAR_NOTASECRET"] = "kept";
      const plainEnv = new LocalEnvironment({ cwd: scratch });
      const r = await plainEnv.exec("echo $PUBLIC_VAR_NOTASECRET");
      expect(r.stdout).toContain("kept");
    });
  });
});

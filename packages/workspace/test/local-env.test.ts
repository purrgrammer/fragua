import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, writeFile as fsWriteFile, mkdtemp, rm, stat, symlink } from "node:fs/promises";
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

  test("writeFile keeps the mode of an existing file (an executable stays executable)", async () => {
    await env.writeFile("run.sh", "#!/bin/sh\necho one\n");
    await chmod(join(scratch, "run.sh"), 0o755);
    await env.writeFile("run.sh", "#!/bin/sh\necho two\n");
    const mode = (await stat(join(scratch, "run.sh"))).mode & 0o777;
    expect(mode).toBe(0o755);
    expect(await env.readFile("run.sh")).toBe("#!/bin/sh\necho two\n");
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

  describe("backgrounded-process reaping (issue #34)", () => {
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const waitForDeath = async (pid: number, withinMs: number): Promise<boolean> => {
      const deadline = Date.now() + withinMs;
      while (Date.now() < deadline) {
        if (!isAlive(pid)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return !isAlive(pid);
    };

    test("a backgrounded child with closed pipes is reaped, not orphaned", async () => {
      const pidFile = join(scratch, "bg.pid");
      // Closed pipes (`>/dev/null 2>&1 &`) → child.on("close") fires
      // immediately with exit 0, but the backgrounded sleeper survives.
      // `$!` captures the real pid of the backgrounded sleep.
      const r = await env.exec(`sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`);
      expect(r.exitCode).toBe(0);

      const pid = Number((await env.readFile("bg.pid")).trim());
      expect(Number.isInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);

      const reaped = await waitForDeath(pid, 4_000);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      expect(reaped).toBe(true);
    }, 10_000);

    test("timeout escalates to SIGKILL for a SIGTERM-ignoring child (keepAlive backstop holds the loop)", async () => {
      const pidFile = join(scratch, "trap.pid");
      // The shell ignores SIGTERM, so the reap's SIGTERM is a no-op and only
      // the 2s SIGKILL backstop can kill it. On the kill/timeout path that
      // backstop is NOT `.unref()`'d — it holds the loop until escalation so
      // a short-lived executor can't exit the window and orphan the child.
      const r = await env.exec(`echo $$ > ${pidFile}; trap '' TERM; sleep 30`, { timeoutMs: 200 });
      expect(r.exitCode).toBe(124);

      const pid = Number((await env.readFile("trap.pid")).trim());
      const reaped = await waitForDeath(pid, 4_000);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      expect(reaped).toBe(true);
    }, 10_000);

    test("a normal foreground call still returns its exit code and stdout", async () => {
      const r = await env.exec("echo hi; exit 7");
      expect(r.stdout).toContain("hi");
      expect(r.exitCode).toBe(7);
    });

    test("abort still reaps and reports exitCode 130", async () => {
      const ac = new AbortController();
      const pidFile = join(scratch, "abort.pid");
      const p = env.exec(`echo $$ > ${pidFile}; exec sleep 30`, { signal: ac.signal });
      // Give the shell a moment to spawn and write its pid.
      await new Promise((r) => setTimeout(r, 200));
      ac.abort();
      const r = await p;
      expect(r.exitCode).toBe(130);
      expect(r.stderr).toContain("aborted");

      const pid = Number((await env.readFile("abort.pid")).trim());
      const reaped = await waitForDeath(pid, 4_000);
      if (isAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      expect(reaped).toBe(true);
    }, 10_000);
  });

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

    test("resolvePath-backed reads return bytes for an in-cwd file via readFileBytes", async () => {
      await env.writeFile("ok.txt", "bytes here");
      const bytes = await env.readFileBytes("ok.txt");
      expect(Buffer.from(bytes).toString("utf8")).toBe("bytes here");
    });

    test("readFileBytes throws PathEscapeError on a symlink inside cwd targeting outside", async () => {
      const outside = await mkdtemp(join(tmpdir(), "fragua-escape-bytes-"));
      try {
        await fsWriteFile(join(outside, "secret.txt"), "leaked");
        await symlink(join(outside, "secret.txt"), join(scratch, "shortcut"));
        await expect(env.readFileBytes("shortcut")).rejects.toBeInstanceOf(PathEscapeError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe("envAllowNames (deny-by-default)", () => {
    const SEEDED = ["GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "MY_SECRET_TOKEN", "PUBLIC_VAR_NOTASECRET"] as const;
    let savedVars: Record<string, string | undefined>;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedVars = {};
      for (const k of SEEDED) {
        savedVars[k] = process.env[k];
        delete process.env[k];
      }
      savedHome = process.env["HOME"];
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(savedVars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
    });

    test("(a) a seeded GITHUB_TOKEN / AWS_ACCESS_KEY_ID is absent from the shell unless allow-listed", async () => {
      process.env["GITHUB_TOKEN"] = "ghp-must-not-leak-abcdef";
      process.env["AWS_ACCESS_KEY_ID"] = "AKIA-must-not-leak-abcdef";
      const env = new LocalEnvironment({ cwd: scratch });
      const r = await env.exec('echo "G=${GITHUB_TOKEN:-MISSING} A=${AWS_ACCESS_KEY_ID:-MISSING}"');
      expect(r.stdout).toContain("G=MISSING");
      expect(r.stdout).toContain("A=MISSING");
      expect(r.stdout).not.toContain("must-not-leak");
    });

    test("(b) an allow-listed var passes through, and a non-listed sibling stays hidden", async () => {
      process.env["GITHUB_TOKEN"] = "ghp-allowed-visible-abcdef";
      process.env["AWS_ACCESS_KEY_ID"] = "AKIA-still-hidden-abcdef";
      const env = new LocalEnvironment({ cwd: scratch, envAllowNames: new Set(["GITHUB_TOKEN"]) });
      const r = await env.exec('echo "G=${GITHUB_TOKEN:-MISSING} A=${AWS_ACCESS_KEY_ID:-MISSING}"');
      expect(r.stdout).toContain("G=ghp-allowed-visible-abcdef");
      expect(r.stdout).toContain("A=MISSING");
    });

    test("(c) a converge-style shell sees PATH and HOME but not a seeded GITHUB_TOKEN", async () => {
      process.env["HOME"] = "/tmp/fake-home-for-converge";
      process.env["GITHUB_TOKEN"] = "ghp-must-not-leak-abcdef";
      const env = new LocalEnvironment({ cwd: scratch });
      const r = await env.exec('echo "P=${PATH:-MISSING} H=${HOME:-MISSING} G=${GITHUB_TOKEN:-MISSING}"');
      expect(r.stdout).toMatch(/P=[^\s]*\//);
      expect(r.stdout).toContain("H=/tmp/fake-home-for-converge");
      expect(r.stdout).toContain("G=MISSING");
    });

    test("(d) engine-set FRAGUA_OUTPUT (via opts.env) always passes the allow-filter", async () => {
      // The `$FRAGUA_OUTPUT` channel a producing tool reads is supplied through
      // opts.env, not inherited from the ambient env, so it always survives.
      const env = new LocalEnvironment({ cwd: scratch });
      const r = await env.exec("echo O=${FRAGUA_OUTPUT:-STRIPPED}", { env: { FRAGUA_OUTPUT: "/tmp/scratch-x" } });
      expect(r.stdout).toContain("O=/tmp/scratch-x");
    });

    test("(e) an ambient FRAGUA_* var is DROPPED unless allow-listed", async () => {
      const prev = process.env["FRAGUA_FOO"];
      process.env["FRAGUA_FOO"] = "ambient-must-not-leak-abcdef";
      try {
        const env = new LocalEnvironment({ cwd: scratch });
        const r = await env.exec("echo F=${FRAGUA_FOO:-MISSING}");
        expect(r.stdout).toContain("F=MISSING");
        expect(r.stdout).not.toContain("ambient-must-not-leak");
      } finally {
        if (prev === undefined) delete process.env["FRAGUA_FOO"];
        else process.env["FRAGUA_FOO"] = prev;
      }
    });

    test("(e2) an ambient FRAGUA_FOO reaches the subprocess when explicitly allow-listed", async () => {
      const prev = process.env["FRAGUA_FOO"];
      process.env["FRAGUA_FOO"] = "allow-listed-visible-abcdef";
      try {
        const env = new LocalEnvironment({ cwd: scratch, envAllowNames: new Set(["FRAGUA_FOO"]) });
        const r = await env.exec("echo F=${FRAGUA_FOO:-MISSING}");
        expect(r.stdout).toContain("F=allow-listed-visible-abcdef");
      } finally {
        if (prev === undefined) delete process.env["FRAGUA_FOO"];
        else process.env["FRAGUA_FOO"] = prev;
      }
    });
  });

  describe("envAllowPredicate", () => {
    const LATE_VAR = "LATE_CI_WIDGET";
    let savedLate: string | undefined;

    beforeEach(() => {
      savedLate = process.env[LATE_VAR];
      delete process.env[LATE_VAR];
    });

    afterEach(() => {
      if (savedLate === undefined) delete process.env[LATE_VAR];
      else process.env[LATE_VAR] = savedLate;
    });

    test("(f) a var admitted by envAllowPredicate SET AFTER construction reaches the subprocess", async () => {
      const env = new LocalEnvironment({ cwd: scratch, envAllowPredicate: (n) => n.startsWith("LATE_CI_") });
      // Set the var AFTER construction — the predicate is applied at spawn time.
      process.env[LATE_VAR] = "late-visible-value-abcdef";
      const r = await env.exec(`echo "V=${"$"}{${LATE_VAR}:-MISSING}"`);
      expect(r.stdout).toContain("V=late-visible-value-abcdef");
    });

    test("(g) a var NOT matched by the predicate stays hidden", async () => {
      process.env[LATE_VAR] = "should-stay-hidden-abcdef";
      const env = new LocalEnvironment({ cwd: scratch, envAllowPredicate: (n) => n === "SOMETHING_ELSE" });
      const r = await env.exec(`echo "V=${"$"}{${LATE_VAR}:-MISSING}"`);
      expect(r.stdout).toContain("V=MISSING");
      expect(r.stdout).not.toContain("should-stay-hidden");
    });
  });

  // The daemon / ci assemblies (see `daemonEnvAllow` in @fragua/cli) refuse
  // provider-credential names before they reach the allow-list, so a provider
  // key is never allowed and never reaches the shell. This exercises the
  // resulting shape without importing the CLI (dep-direction rule).
  describe("provider-credential exclusion (allow-list model)", () => {
    const CRED_VAR = "ANTHROPIC_API_KEY";
    const PASS_VAR = "GH_TOKEN";
    let savedCred: string | undefined;
    let savedPass: string | undefined;

    beforeEach(() => {
      savedCred = process.env[CRED_VAR];
      savedPass = process.env[PASS_VAR];
    });

    afterEach(() => {
      if (savedCred === undefined) delete process.env[CRED_VAR];
      else process.env[CRED_VAR] = savedCred;
      if (savedPass === undefined) delete process.env[PASS_VAR];
      else process.env[PASS_VAR] = savedPass;
    });

    test("(h) a provider cred not on the allow-list is absent from the bash subprocess", async () => {
      process.env[CRED_VAR] = "sk-ant-must-not-leak-abcdef";
      const env = new LocalEnvironment({ cwd: scratch, envAllowNames: new Set([PASS_VAR]) });
      const r = await env.exec(`echo "V=${"$"}{${CRED_VAR}:-MISSING}"`);
      expect(r.stdout).toContain("V=MISSING");
      expect(r.stdout).not.toContain("sk-ant-must-not-leak-abcdef");
    });

    test("(i) an allow-listed GH_TOKEN IS visible in the bash subprocess", async () => {
      process.env[PASS_VAR] = "ghs-passthrough-visible-abcdef";
      const env = new LocalEnvironment({ cwd: scratch, envAllowNames: new Set([PASS_VAR]) });
      const r = await env.exec(`echo "V=${"$"}{${PASS_VAR}:-MISSING}"`);
      expect(r.stdout).toContain("V=ghs-passthrough-visible-abcdef");
    });
  });
});

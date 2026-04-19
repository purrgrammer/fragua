import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";
import { gitReadTool } from "../src/tools.ts";

describe("local:git_read", () => {
  let scratch: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-gitread-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: scratch });
    spawnSync("git", ["config", "user.email", "test@swarm.local"], { cwd: scratch });
    spawnSync("git", ["config", "user.name", "swarm test"], { cwd: scratch });
    await writeFile(join(scratch, "note.txt"), "hello\n");
    spawnSync("git", ["add", "note.txt"], { cwd: scratch });
    spawnSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: scratch });
    env = new LocalEnvironment({ cwd: scratch });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("status reports clean tree", async () => {
    const r = await gitReadTool.execute({ subcommand: "status", args: ["--short"] }, env);
    expect(r.is_error).toBe(false);
    expect(r.text).toContain("exit: 0");
  });

  test("log returns the commit", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["--oneline"] }, env);
    expect(r.is_error).toBe(false);
    expect(r.text).toContain("initial commit");
  });

  test("rev-parse HEAD returns a sha", async () => {
    const r = await gitReadTool.execute({ subcommand: "rev-parse", args: ["HEAD"] }, env);
    expect(r.is_error).toBe(false);
    expect(r.text).toMatch(/[0-9a-f]{40}/);
  });

  test("pathspec with space is safe without shell", async () => {
    await writeFile(join(scratch, "a file.txt"), "x");
    spawnSync("git", ["add", "a file.txt"], { cwd: scratch });
    const r = await gitReadTool.execute({ subcommand: "status", args: ["--short", "--", "a file.txt"] }, env);
    expect(r.is_error).toBe(false);
    expect(r.text).toContain("a file.txt");
  });

  test("rejects -c config injection", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["-c", "core.sshCommand=/bin/sh"] }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("denied flag");
  });

  test("rejects -C directory escape", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["-C", "/etc"] }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("denied flag");
  });

  test("rejects --exec-path override", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["--exec-path=/tmp/evil"] }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("denied flag");
  });

  test("rejects --upload-pack RCE vector", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["--upload-pack=evil"] }, env);
    expect(r.is_error).toBe(true);
  });

  test("rejects --git-dir rebind", async () => {
    const r = await gitReadTool.execute({ subcommand: "log", args: ["--git-dir=/tmp"] }, env);
    expect(r.is_error).toBe(true);
  });

  test("shell metachars in args are inert (no shell interpretation)", async () => {
    // `;` in an arg would execute a second command if a shell were involved.
    // Without a shell, git receives the whole string as a single argv entry
    // and complains that it isn't a valid ref — proving no shell ran.
    const r = await gitReadTool.execute({ subcommand: "log", args: [`; touch /tmp/swarm-pwn-${Date.now()}`] }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("ambiguous argument");
  });
});

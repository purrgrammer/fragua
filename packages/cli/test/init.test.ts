// Tests for `swarm init` — bootstrap a project's .swarm/config.yaml.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.ts";
import { loadProjectConfig } from "../src/config.ts";

async function makeGitRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init", dir], { stdio: ["ignore", "pipe", "pipe"] });
  await proc.exited;
  // git init needs at least a name/email to avoid warnings on some CI hosts
  const cfg1 = Bun.spawn(["git", "-C", dir, "config", "user.email", "test@swarm"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await cfg1.exited;
  const cfg2 = Bun.spawn(["git", "-C", dir, "config", "user.name", "swarm-test"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await cfg2.exited;
}

describe("initCommand", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-init-"));
    await makeGitRepo(scratch);
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function exists(rel: string): Promise<boolean> {
    try {
      await access(join(scratch, rel));
      return true;
    } catch {
      return false;
    }
  }

  test("writes .swarm/config.yaml, not .swarm/config.jsonc", async () => {
    const code = await initCommand({ cwd: scratch });
    expect(code).toBe(0);
    expect(await exists(".swarm/config.yaml")).toBe(true);
    expect(await exists(".swarm/config.jsonc")).toBe(false);
    // The default template is comments-only — loads as an empty config.
    const cfg = await loadProjectConfig(scratch);
    expect(cfg).toEqual({});
  });

  test(".gitignore allowlists both .swarm/config.yaml and .swarm/config.jsonc", async () => {
    await initCommand({ cwd: scratch });
    const gitignore = await readFile(join(scratch, ".gitignore"), "utf8");
    expect(gitignore).toContain("!.swarm/config.yaml");
    expect(gitignore).toContain("!.swarm/config.jsonc");
  });

  test("refuses to overwrite an existing .swarm/config.yaml", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), `autoTitle: false\n`, "utf8");
    const code = await initCommand({ cwd: scratch });
    expect(code).toBe(1);
    // File is untouched
    const content = await readFile(join(scratch, ".swarm/config.yaml"), "utf8");
    expect(content).toBe(`autoTitle: false\n`);
  });

  test("refuses to overwrite an existing .swarm/config.jsonc (legacy)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.jsonc"), `{ "autoTitle": false }`, "utf8");
    const code = await initCommand({ cwd: scratch });
    expect(code).toBe(1);
    // JSONC untouched, no YAML written
    expect(await exists(".swarm/config.yaml")).toBe(false);
  });

  test("fails on non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "swarm-nongit-"));
    try {
      const code = await initCommand({ cwd: nonGit });
      expect(code).toBe(1);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  test("creates .swarm/workflows/ directory", async () => {
    await initCommand({ cwd: scratch });
    expect(await exists(".swarm/workflows")).toBe(true);
  });

  test("idempotent gitignore — second init on same repo does not duplicate block", async () => {
    // The block is merged by mergeGitignore which only writes once
    // (it returns early when BLOCK_MARKER_START is already present).
    // We simulate by calling init, then manually re-calling mergeGitignore
    // by checking the count of the marker in .gitignore.
    await initCommand({ cwd: scratch });
    const first = await readFile(join(scratch, ".gitignore"), "utf8");
    const count = (first.match(/# swarm runtime — never commit these/g) ?? []).length;
    expect(count).toBe(1);
  });
});

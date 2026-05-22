// Tests for project identity resolution: walk-up to the nearest config
// bounded by the git root, exact-cwd outside git, and auto-init.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUuidv7 } from "@fragua/core";
import { loadProjectConfig } from "../src/config.ts";
import { resolveProject } from "../src/project.ts";

async function git(dir: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"] });
  await p.exited;
}

async function initRepo(dir: string): Promise<void> {
  const p = Bun.spawn(["git", "init", dir], { stdio: ["ignore", "ignore", "ignore"] });
  await p.exited;
  await git(dir, "config", "user.email", "t@fragua");
  await git(dir, "config", "user.name", "fragua-test");
}

async function writeConfig(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, ".fragua"), { recursive: true });
  await writeFile(join(dir, ".fragua/config.yaml"), body, "utf8");
}

describe("resolveProject", () => {
  let repo: string;

  beforeEach(async () => {
    // realpath so assertions match git's reported toplevel (macOS /var → /private/var).
    repo = await realpath(await mkdtemp(join(tmpdir(), "fragua-proj-")));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("walks up from a subdir to the root config (one repo, one identity)", async () => {
    await writeConfig(repo, "id: root-id\nname: myrepo\n");
    const sub = join(repo, "packages/api");
    await mkdir(sub, { recursive: true });

    const r = await resolveProject(sub);
    expect(r.projectId).toBe("root-id");
    expect(r.projectName).toBe("myrepo");
    // cwd records the project root, not the invocation subdir.
    expect(r.projectRoot).toBe(repo);
    expect(r.created).toBe(false);
  });

  test("a subdirectory config wins (deepest-first), defining its own project", async () => {
    await writeConfig(repo, "id: root-id\nname: myrepo\n");
    const sub = join(repo, "packages/api");
    await writeConfig(sub, "id: sub-id\nname: api\n");

    const r = await resolveProject(sub);
    expect(r.projectId).toBe("sub-id");
    expect(r.projectName).toBe("api");
    expect(r.projectRoot).toBe(sub);
  });

  test("git-root ceiling: a config ABOVE the repo is never read as identity", async () => {
    // A directory above the git root carries a config; resolving inside the
    // repo must NOT climb into it (it would be like reading ~/.fragua) — it
    // auto-inits a fresh id at the repo root instead.
    const outer = await realpath(await mkdtemp(join(tmpdir(), "fragua-outer-")));
    try {
      await writeConfig(outer, "id: PARENT-SHOULD-NOT-WIN\nname: outer\n");
      const inner = join(outer, "the-repo");
      await mkdir(inner, { recursive: true });
      await initRepo(inner);

      const r = await resolveProject(inner);
      expect(r.projectId).not.toBe("PARENT-SHOULD-NOT-WIN");
      expect(isUuidv7(r.projectId)).toBe(true);
      expect(r.projectRoot).toBe(inner);
      expect(r.created).toBe(true);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  test("auto-init mints a real UUIDv7 id + dir-name name at the git root", async () => {
    const sub = join(repo, "deep/nested");
    await mkdir(sub, { recursive: true });

    const r = await resolveProject(sub);
    expect(isUuidv7(r.projectId)).toBe(true);
    expect(r.projectRoot).toBe(repo);
    expect(r.created).toBe(true);
    expect(r.committed).toBe(false); // freshly written, not committed

    // The config landed at the git root and is loadable.
    const cfg = await loadProjectConfig(repo);
    expect(cfg.id).toBe(r.projectId);
    expect(cfg.name).toBe(r.projectName);
    // gitignore got the runtime block.
    const gi = await readFile(join(repo, ".gitignore"), "utf8");
    expect(gi).toContain("!.fragua/config.yaml");
  });

  test("committed=true once the config is tracked by git", async () => {
    await writeConfig(repo, "id: c-id\nname: committed\n");
    await git(repo, "add", ".fragua/config.yaml");
    await git(repo, "commit", "-m", "add config");

    const r = await resolveProject(repo);
    expect(r.projectId).toBe("c-id");
    expect(r.committed).toBe(true);
  });

  test("non-git directory: exact-cwd resolution, auto-init at cwd", async () => {
    const nonGit = await realpath(await mkdtemp(join(tmpdir(), "fragua-nongit-")));
    try {
      const r = await resolveProject(nonGit);
      expect(isUuidv7(r.projectId)).toBe(true);
      expect(r.projectRoot).toBe(nonGit);
      expect(r.committed).toBe(false);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  test("config without an id is back-filled with a minted id (comments preserved)", async () => {
    await writeConfig(repo, "# hand-rolled\nname: legacy\nauto-title: false\n");

    const r = await resolveProject(repo);
    expect(isUuidv7(r.projectId)).toBe(true);
    expect(r.projectName).toBe("legacy");
    expect(r.created).toBe(true);

    const body = await readFile(join(repo, ".fragua/config.yaml"), "utf8");
    expect(body).toContain(`id: ${r.projectId}`);
    expect(body).toContain("# hand-rolled");
    expect(body).toContain("auto-title: false");
  });
});

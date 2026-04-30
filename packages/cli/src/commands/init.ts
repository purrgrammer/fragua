// `swarm init` — bootstrap a project's `.swarm/config.jsonc` with a
// freshly minted UUIDv7. Hard-fails on non-git directories: identity that
// doesn't travel with the source tree silently un-groups runs across
// clones. Refuses to overwrite an existing `.swarm/config.jsonc`, and
// refuses to mint a new id if a previous `swarm init` already committed
// one to `HEAD` (a clone re-init would split the project from itself).
//
// Side effects on success:
//   - writes `<cwd>/.swarm/config.jsonc`
//   - creates `<cwd>/.swarm/workflows/` if absent
//   - merges runtime patterns into `<cwd>/.gitignore` (idempotent)
//
// Bare invocation: `swarm init`. No flags in v0.

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { uuidv7 } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";

const GITIGNORE_BLOCK = `# swarm runtime — never commit these
.swarm/runs/
.swarm/worktrees/
.swarm/swarm.db*
.swarm/daemon/
.swarm/credentials.jsonc
.swarm/serve.json

# swarm — always commit these (negative patterns for clarity)
!.swarm/config.jsonc
!.swarm/workflows/
`;

const BLOCK_MARKER_START = "# swarm runtime — never commit these";

export interface InitCommandOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
}

export async function initCommand(opts: InitCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = resolve(cwd, ".swarm/config.jsonc");

  if (!(await isGitRepo(cwd))) {
    console.error(chalk.red("init: not a git repository"));
    console.error(chalk.dim("  swarm projects are git-shaped: identity is committed so clones group correctly."));
    console.error(chalk.dim("  run `git init` first, then re-run `swarm init`."));
    return 1;
  }

  if (await pathExists(configPath)) {
    console.error(chalk.red(`init: ${configPath} already exists — refusing to overwrite`));
    return 1;
  }

  if (await isTrackedInHead(cwd, ".swarm/config.jsonc")) {
    console.error(chalk.red("init: .swarm/config.jsonc is reachable from HEAD but not present on disk"));
    console.error(chalk.dim("  the file was committed in another clone; check it out instead of re-initializing."));
    console.error(chalk.dim("  `git checkout HEAD -- .swarm/config.jsonc`"));
    return 1;
  }

  const id = uuidv7();
  const name = basename(resolve(cwd));
  const body = renderConfig({ id, name });

  await mkdir(resolve(cwd, ".swarm/workflows"), { recursive: true });
  await writeFile(configPath, body, "utf8");
  await mergeGitignore(cwd);

  // Pre-register in the projects display cache so `swarm projects ls` and
  // the UI show the project before its first run. Opens (and creates, if
  // missing) `<cwd>/.swarm/swarm.db`. `enqueueRun` UPSERTs the same row
  // on every run, so this is a fast-path for the post-init UX and not a
  // correctness requirement.
  const store = new SqliteStore({ path: resolve(cwd, ".swarm/swarm.db") });
  try {
    store.upsertProject({ id, name, rootPath: resolve(cwd) });
  } finally {
    store.close();
  }

  console.log(chalk.green(`✓ wrote ${configPath}`));
  console.log(chalk.dim(`  id: ${id}`));
  console.log(chalk.dim(`  name: ${name}`));
  console.log(chalk.dim("  workflows: .swarm/workflows/ (empty)"));
  console.log(chalk.dim("  next: commit .swarm/config.jsonc so clones share this id."));
  return 0;
}

function renderConfig(args: { id: string; name: string }): string {
  return `{
  // swarm project config — see docs/proposals/project-config.md.
  // \`id\` and \`name\` are committed; runtime state under .swarm/
  // (runs, worktrees, db) is gitignored.
  "version": 1,
  "id": "${args.id}",
  "name": ${JSON.stringify(args.name)}
}
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function mergeGitignore(cwd: string): Promise<void> {
  const path = resolve(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    // missing — write fresh
  }
  if (existing.includes(BLOCK_MARKER_START)) {
    return; // already merged; idempotent
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  await writeFile(path, `${existing}${sep}${GITIGNORE_BLOCK}`, "utf8");
}

function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
}

function isTrackedInHead(cwd: string, relPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["ls-tree", "-r", "--name-only", "HEAD", relPath], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.on("close", (code) => {
      resolvePromise(code === 0 && stdout.trim().length > 0);
    });
    child.on("error", () => resolvePromise(false));
  });
}

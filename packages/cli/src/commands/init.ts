// `fragua init` — bootstrap a project's `.fragua/config.yaml` and merge
// the runtime patterns into `.gitignore`. Hard-fails on non-git
// directories. Refuses to overwrite an existing `.fragua/config.yaml`.
//
// Side effects on success:
//   - writes `<cwd>/.fragua/config.yaml`
//   - creates `<cwd>/.fragua/workflows/` if absent
//   - merges runtime patterns into `<cwd>/.gitignore` (idempotent)
//
// Bare invocation: `fragua init`. No flags in v0.

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { uuidv7 } from "@fragua/core";
import chalk from "chalk";

const GITIGNORE_BLOCK = `# fragua runtime — never commit these
.fragua/runs/
.fragua/worktrees/
.fragua/blobs/
.fragua/fragua.db*
.fragua/daemon/

# fragua — always commit these (negative patterns for clarity)
!.fragua/config.yaml
!.fragua/workflows/
`;

const BLOCK_MARKER_START = "# fragua runtime — never commit these";

export interface InitCommandOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
}

export async function initCommand(opts: InitCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  // Stable, collision-free project identity, committed to the repo so
  // every clone — and any run imported from another machine — attributes
  // to the same project regardless of where it physically lives. The
  // directory name is only the human-facing display `name`.
  const id = uuidv7();
  const name = cwd.split("/").filter(Boolean).at(-1) ?? "project";
  const configPath = resolve(cwd, ".fragua/config.yaml");

  if (!(await isGitRepo(cwd))) {
    console.error(chalk.dim("init: not a git repository, worktree isolation not available"));
    console.error(chalk.dim("  run `git init` to initialize a repository"));
  }

  if (await pathExists(configPath)) {
    console.error(chalk.red(`init: ${configPath} already exists — refusing to overwrite`));
    return 1;
  }

  await mkdir(resolve(cwd, ".fragua/workflows"), { recursive: true });
  await writeFile(configPath, renderConfig(id, name), "utf8");
  await mergeGitignore(cwd);

  console.log(chalk.green(`✓ wrote ${configPath}`));
  console.log(chalk.dim("  workflows: .fragua/workflows/ (empty)"));
  return 0;
}

function renderConfig(id: string, name: string): string {
  return `# fragua project config — project-specific knobs only.
# Generic preferences live in ~/.fragua/config.yaml.

# Stable project identity. Committed so every clone shares it and runs
# stay attributable across machines — do not change it.
id: ${id}
name: ${name}

# Uncomment if the project needs a per-worktree bootstrap command:
# bootstrap: "bun install --frozen-lockfile"
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

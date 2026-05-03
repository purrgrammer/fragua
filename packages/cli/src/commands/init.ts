// `swarm init` — bootstrap a project's `.swarm/config.jsonc` and merge
// the runtime patterns into `.gitignore`. Hard-fails on non-git
// directories. Refuses to overwrite an existing `.swarm/config.jsonc`.
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
import chalk from "chalk";

const GITIGNORE_BLOCK = `# swarm runtime — never commit these
.swarm/runs/
.swarm/worktrees/
.swarm/blobs/
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
    console.error(chalk.dim("  run `git init` first, then re-run `swarm init`."));
    return 1;
  }

  if (await pathExists(configPath)) {
    console.error(chalk.red(`init: ${configPath} already exists — refusing to overwrite`));
    return 1;
  }

  const name = basename(resolve(cwd));
  const body = renderConfig({ name });

  await mkdir(resolve(cwd, ".swarm/workflows"), { recursive: true });
  await writeFile(configPath, body, "utf8");
  await mergeGitignore(cwd);

  console.log(chalk.green(`✓ wrote ${configPath}`));
  console.log(chalk.dim(`  name: ${name}`));
  console.log(chalk.dim("  workflows: .swarm/workflows/ (empty)"));
  return 0;
}

function renderConfig(args: { name: string }): string {
  return `{
  // swarm project config — see docs/proposals/project-config.md.
  "version": 1,
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

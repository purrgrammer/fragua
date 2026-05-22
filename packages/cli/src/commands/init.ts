// `fragua init` — bootstrap a project's `.fragua/config.yaml` at the git
// root and merge the runtime patterns into `.gitignore`. Warns (does not
// fail) on non-git directories. Refuses to overwrite an existing config.
//
// Side effects on success:
//   - writes `<project-root>/.fragua/config.yaml` (git root, else cwd)
//   - creates `<project-root>/.fragua/workflows/` if absent
//   - merges runtime patterns into `<project-root>/.gitignore` (idempotent)
//
// The scaffold writer is shared with the `fragua run` auto-init path
// (`../project.ts`).

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import { findGitRoot, writeProjectScaffold } from "../project.ts";

export interface InitCommandOptions {
  /** Working directory. Defaults to `process.cwd()`. The config lands at
   *  the git root above it (or here, when not in a repo). */
  cwd?: string;
}

export async function initCommand(opts: InitCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const gitRoot = findGitRoot(cwd);
  if (gitRoot == null) {
    console.error(chalk.dim("init: not a git repository, worktree isolation not available"));
    console.error(chalk.dim("  run `git init` to initialize a repository"));
  }

  const projectRoot = gitRoot ?? cwd;
  const configPath = resolve(projectRoot, ".fragua/config.yaml");
  if (await pathExists(configPath)) {
    console.error(chalk.red(`init: ${configPath} already exists — refusing to overwrite`));
    return 1;
  }

  const { id, name } = await writeProjectScaffold(projectRoot);
  console.log(chalk.green(`✓ wrote ${configPath}`));
  console.log(chalk.dim(`  project: ${name} (${id})`));
  console.log(chalk.dim("  workflows: .fragua/workflows/ (empty)"));
  return 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Workflow argument resolution shared by `swarm run` and `swarm validate`.
//
// Bare names (no slash, no `.dot` suffix) resolve under the global
// workflows directory at `~/.swarm/workflows/<name>.dot`. Anything with
// a path separator or a `.dot` suffix is treated as a literal path so
// callers can still point at scratch files anywhere on disk.
//
// Per-project workflows (`<project>/.swarm/workflows/`) are deferred
// behind project-config extensions; until then, by-name resolution is
// global only.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type WorkflowScope = "global" | "path";

export interface ResolvedWorkflow {
  /** Absolute path to the `.dot` file. */
  dotPath: string;
  /** Logical workflow name (no extension, no directory). For bare-name
   * lookups this is the input verbatim; for path lookups it's the file
   * basename without extension. */
  name: string;
  /** How the argument resolved. `global` for bare names matched under
   * `~/.swarm/workflows/`, `path` for explicit paths. */
  scope: WorkflowScope;
}

export function globalWorkflowsDir(): string {
  return resolve(homedir(), ".swarm/workflows");
}

export async function resolveWorkflow(cwd: string, arg: string): Promise<ResolvedWorkflow | null> {
  const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.endsWith(".dot");
  if (!looksLikePath) {
    const candidate = resolve(globalWorkflowsDir(), `${arg}.dot`);
    if (await fileExists(candidate)) {
      return { dotPath: candidate, name: arg, scope: "global" };
    }
    return null;
  }
  const path = resolve(cwd, arg);
  if (await fileExists(path)) {
    return { dotPath: path, name: stripExtension(basename(arg)), scope: "path" };
  }
  return null;
}

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return slash >= 0 ? p.slice(slash + 1) : p;
}

function stripExtension(leaf: string): string {
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

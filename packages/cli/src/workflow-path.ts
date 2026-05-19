// Workflow argument resolution shared by `swarm run` and `swarm validate`.
//
// Bare names (no slash, no `.yaml` suffix) resolve in two stages:
//   1. `~/.swarm/workflows/<name>.yaml` — global. Generic workflows live
//      here so they're available from any cwd.
//   2. `<cwd>/.swarm/workflows/<name>.yaml` — project-local fallback.
//      Project-internal workflows (this repo's introspect, ci-gate, …)
//      stay near the codebase that owns them.
//
// Anything with a path separator or a `.yaml` suffix is treated as a
// literal path so callers can still point at scratch files anywhere
// on disk.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type WorkflowScope = "global" | "local" | "path";

export interface ResolvedWorkflow {
  /** Absolute path to the `.yaml` file. */
  dotPath: string;
  /** Logical workflow name (no extension, no directory). For bare-name
   * lookups this is the input verbatim; for path lookups it's the file
   * basename without extension. */
  name: string;
  /** How the argument resolved. `global` matched `~/.swarm/workflows/`,
   * `local` fell back to `<cwd>/.swarm/workflows/`, `path` resolved
   * as an explicit filesystem path. */
  scope: WorkflowScope;
}

export function globalWorkflowsDir(home?: string): string {
  return resolve(home ?? homedir(), ".swarm/workflows");
}

export function projectWorkflowsDir(cwd: string): string {
  return resolve(cwd, ".swarm/workflows");
}

/** Resolve a workflow argument. `opts.homeDir` overrides the home base
 * for global lookups (used by tests). */
export async function resolveWorkflow(
  cwd: string,
  arg: string,
  opts: { homeDir?: string } = {},
): Promise<ResolvedWorkflow | null> {
  const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.endsWith(".yaml");
  if (!looksLikePath) {
    const globalCandidate = resolve(globalWorkflowsDir(opts.homeDir), `${arg}.yaml`);
    if (await fileExists(globalCandidate)) {
      return { dotPath: globalCandidate, name: arg, scope: "global" };
    }
    const localCandidate = resolve(projectWorkflowsDir(cwd), `${arg}.yaml`);
    if (await fileExists(localCandidate)) {
      return { dotPath: localCandidate, name: arg, scope: "local" };
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

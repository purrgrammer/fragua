// Read-only view over an ExecutionEnvironment.
//
// The executor wraps `ctx.env` in this proxy when a node's allowed_tools
// set carries no mutating tool (`bash` / `write` / `edit`). That way a
// handler whose *tool* surface is read-only can't escape to the *env*
// surface and mutate the worktree anyway. Cheap alignment between the two
// sides of a node's declared access — if the tools can't write, the raw
// env underneath them can't either.

import type { ExecResult, ExecutionEnvironment } from "./execution.ts";

export class ReadOnlyEnvError extends Error {
  constructor(op: string) {
    super(
      `ReadOnlyEnv: ${op} blocked — this node's allowed_tools does not include bash / write / edit, so its ExecutionEnvironment is read-only`,
    );
    this.name = "ReadOnlyEnvError";
  }
}

/** Tool names whose presence in a node's effective toolset implies the
 * handler legitimately needs a mutating ExecutionEnvironment. Kept
 * hardcoded to the four-tool agent baseline; a custom mutating tool must
 * declare one of these as a co-requirement in `allowed_tools`. */
export const ENV_MUTATOR_TOOLS: readonly string[] = ["bash", "write", "edit"];

export function makeReadOnlyEnv(env: ExecutionEnvironment): ExecutionEnvironment {
  return {
    cwd: () => env.cwd(),
    projectCwd: () => env.projectCwd(),
    readFile: (path) => env.readFile(path),
    exists: (path) => env.exists(path),
    listDir: (path) => env.listDir(path),
    glob: (pattern, opts) => env.glob(pattern, opts),
    writeFile: () => {
      throw new ReadOnlyEnvError("writeFile");
    },
    exec: (_command: string): Promise<ExecResult> => {
      throw new ReadOnlyEnvError("exec");
    },
  };
}

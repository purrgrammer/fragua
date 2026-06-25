// `fragua run <workflow>` — enqueue a run directly on the store, then tail
// its event log (follow by default; `--no-follow` enqueues and exits).
//
// `<workflow>` resolves in two flavours:
//   - bare name (no slash, no `.yaml` suffix): looks up
//     `~/.fragua/workflows/<name>.yaml`. Misses surface as "workflow not
//     found" with a hint to either drop a file there or pass a path.
//   - path (relative or absolute, with slash or `.yaml` suffix): read
//     directly.
//
// Then (store-client — no HTTP, no running server required to enqueue):
//   1. Read the YAML file.
//   2. plane.buildSaveWorkflow(source) → commitSaveWorkflow (content-addressed).
//   3. plane.buildEnqueue → commitEnqueue (mints the run id, validates inputs).
//   4. Follow: poll readPlane.eventsSince in a loop, render each event, exit
//      with the run's terminal status. A daemon must be running for the run to
//      execute; with none, the run sits queued and the tail waits.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import { coerceInputs } from "../input-coerce.ts";
import { resolveProject } from "../project.ts";
import { followRun } from "../run-follow.ts";
import { withStoreClient } from "../store-client.ts";
import { globalWorkflowsDir, projectWorkflowsDir, resolveWorkflow } from "../workflow-path.ts";

export interface RunCommandOptions {
  workflow: string;
  /** Priority tie-breaker. Higher runs first. Default 0. */
  priority?: number;
  /** Starting routing entries injected into run_state.routing. */
  routing?: Record<string, unknown>;
  /** Explicit run title (`--title`). When set, the daemon uses it verbatim
   * and skips auto-titling; otherwise the title is summarised from `inputs`. */
  title?: string;
  /** Typed run inputs (`--input name=value`). Validated against the
   * workflow's `inputs:` block and substituted as `${{ inputs.name }}`. */
  inputs?: Record<string, string>;
  /** Whole inputs object as one JSON value (`--input-json '<json>'`). The
   * programmatic-caller path; merged under per-`--input` overrides. */
  inputJson?: string;
  /** Exit after the run enters a terminal state. Default true. */
  follow?: boolean;
  /** Base directory used to resolve relative workflow paths. Default cwd. */
  cwd?: string;
  /** Store path to enqueue + tail against. Default `~/.fragua/fragua.db`
   * (the harness store). */
  dbPath?: string;
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const invocationCwd = opts.cwd ?? process.cwd();
  // Resolve project identity (walk up to the nearest .fragua/config.yaml,
  // bounded by the git root; auto-init a real id when none is found). The
  // resolved project root — not the invocation dir — is what the run records
  // as its cwd, so all of .fragua/ stays in one place.
  const project = await resolveProject(invocationCwd);
  const cwd = project.projectRoot;
  if (project.created) {
    console.log(chalk.green(`✓ initialized project ${project.projectName} (${project.projectId.slice(0, 8)}…)`));
    console.log(chalk.dim(`  wrote ${cwd}/.fragua/config.yaml — commit it to share this project across clones`));
  } else if (!project.committed) {
    console.error(
      chalk.yellow("run: .fragua/config.yaml is not committed — this run won't be portable until you commit it"),
    );
  }
  const resolved = await resolveWorkflow(cwd, opts.workflow);
  if (resolved == null) {
    const looksLikePath = opts.workflow.includes("/") || opts.workflow.endsWith(".yaml");
    if (looksLikePath) {
      console.error(chalk.red(`run: workflow not found: ${opts.workflow} (resolved as path)`));
    } else {
      console.error(chalk.red(`run: workflow not found: ${opts.workflow}`));
      console.error(
        chalk.dim(
          `  looked in ${globalWorkflowsDir()}/${opts.workflow}.yaml, then ${projectWorkflowsDir(cwd)}/${opts.workflow}.yaml`,
        ),
      );
      console.error(chalk.dim(`  drop a .yaml file in either location, or pass a path explicitly`));
    }
    return 1;
  }
  const { dotPath, name, scope } = resolved;

  let source: string;
  try {
    source = await readFile(dotPath, "utf8");
  } catch (err) {
    console.error(chalk.red(`run: cannot read ${dotPath}: ${(err as Error).message}`));
    return 1;
  }

  // Save (content-addressed) + enqueue + (optionally) follow — all on the
  // local store. No server needed to record the run; a daemon executes it.
  return withStoreClient(opts, async (client) => {
    const mint = client.plane.buildSaveWorkflow(source);
    if (!mint.ok) {
      const verb = mint.reason === "invalid" ? "failed validation" : "did not parse";
      console.error(chalk.red(`run: ${opts.workflow} ${verb}: ${mint.detail}`));
      return 1;
    }
    client.plane.commitSaveWorkflow({ sha: mint.sha, name, source, ir: mint.ir, irVersion: mint.irVersion });
    console.log(chalk.dim(`workflow ${name} -> ${mint.sha.slice(0, 12)}`));

    const inputDecls = mint.graph.attrs.inputs ?? [];
    let inputs: Record<string, unknown>;
    try {
      inputs = coerceInputs(opts.inputs ?? {}, opts.inputJson);
    } catch (err) {
      console.error(chalk.red(`run: ${(err as Error).message}`));
      return 1;
    }

    const enq = client.plane.buildEnqueue({
      workflowSha: mint.sha,
      inputDecls,
      cwd: resolve(cwd),
      projectId: project.projectId,
      projectName: project.projectName,
      workflowScope: scope,
      workflowPath: dotPath,
      ...(scope === "global" || scope === "local" ? { workflowName: name } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    });
    if (!enq.ok) {
      console.error(chalk.red(`run: ${enq.error}`));
      return 1;
    }
    client.plane.commitEnqueue(enq.params);
    if (opts.title !== undefined && opts.title.length > 0) client.store.setRunTitle(enq.runId, opts.title);
    console.log(chalk.green(`run queued: ${enq.runId}`));

    if (opts.follow === false) return 0;
    return followRun(client, enq.runId);
  });
}

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
import type { StoredEvent } from "@fragua/store";
import chalk from "chalk";
import { resolveProject } from "../project.ts";
import { type StoreClient, withStoreClient } from "../store-client.ts";
import { globalWorkflowsDir, projectWorkflowsDir, resolveWorkflow } from "../workflow-path.ts";

/** Parse repeated `--input name=value` args into a resolved map. A value
 * of `@<path>` reads the file verbatim; `@-` reads stdin (once, cached for
 * reuse). Type coercion is the server's job (against the workflow's
 * `inputs:` schema) — this only resolves the string. Throws on a malformed
 * entry (missing `=` or empty name) or an unreadable `@` source. */
export async function resolveInputArgs(raw: string | string[] | undefined): Promise<Record<string, string>> {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  let stdinCache: string | undefined;
  for (const entry of list) {
    const s = String(entry);
    const eq = s.indexOf("=");
    if (eq <= 0) throw new Error(`--input must be name=value (got ${JSON.stringify(s)})`);
    const name = s.slice(0, eq);
    const rawVal = s.slice(eq + 1);
    if (rawVal.startsWith("@")) {
      const src = rawVal.slice(1);
      if (src === "-") {
        stdinCache ??= await Bun.stdin.text();
        out[name] = stdinCache;
      } else {
        out[name] = await readFile(src, "utf8");
      }
    } else {
      out[name] = rawVal;
    }
  }
  return out;
}

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
  /** Exit after the run enters a terminal state. Default true. */
  follow?: boolean;
  /** Base directory used to resolve relative workflow paths. Default cwd. */
  cwd?: string;
  /** Store path to enqueue + tail against. Default `~/.fragua/fragua.db`
   * (the harness store). */
  dbPath?: string;
}

const TERMINAL_TYPES = new Set<string>([
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_paused_human",
  "fact.run_quarantined",
]);

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
      console.error(chalk.red(`run: ${opts.workflow} did not parse: ${mint.detail}`));
      return 1;
    }
    client.plane.commitSaveWorkflow({ sha: mint.sha, name, source, ir: mint.ir, irVersion: mint.irVersion });
    console.log(chalk.dim(`workflow ${name} -> ${mint.sha.slice(0, 12)}`));

    const enq = client.plane.buildEnqueue({
      workflowSha: mint.sha,
      inputDecls: mint.graph.attrs.inputs ?? [],
      cwd: resolve(cwd),
      projectId: project.projectId,
      projectName: project.projectName,
      workflowScope: scope,
      workflowPath: dotPath,
      ...(scope === "global" || scope === "local" ? { workflowName: name } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
      ...(opts.inputs !== undefined && Object.keys(opts.inputs).length > 0 ? { inputs: opts.inputs } : {}),
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

const POLL_MS = 200;
const BATCH = 500;

/** Tail a run's event log to terminal: poll `readPlane.eventsSince`, render
 * each new event, return the run's terminal exit code. A daemon must be running
 * for events to appear — with none the run sits queued and this waits (Ctrl-C
 * to stop), same as the old SSE follow. */
async function followRun(client: StoreClient, runId: string): Promise<number> {
  let cursor = 0;
  for (;;) {
    const batch = client.readPlane.eventsSince(runId, cursor, BATCH);
    for (const ev of batch) {
      renderEvent(ev);
      cursor = ev.seq;
      if (TERMINAL_TYPES.has(ev.type)) {
        if (ev.type === "fact.run_paused_human") console.log(chalk.yellow("run paused for human input — exiting."));
        return ev.type === "fact.run_halted" ? 1 : ev.type === "fact.run_cancelled" ? 130 : 0;
      }
    }
    // A non-full batch means we've caught up to the live tail — wait for more.
    if (batch.length < BATCH) await sleep(POLL_MS);
  }
}

function renderEvent(ev: StoredEvent): void {
  const color = ev.type.startsWith("fact.run_completed")
    ? chalk.green
    : ev.type.startsWith("fact.run_halted") || ev.type.startsWith("fact.run_cancelled")
      ? chalk.red
      : ev.type.startsWith("intent.")
        ? chalk.blue
        : chalk.dim;
  console.log(`${chalk.dim(`[${ev.seq}]`)} ${color(ev.type)} ${JSON.stringify(ev.payload ?? {})}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
import type { InputDecl } from "@fragua/core";
import chalk from "chalk";
import { resolveProject } from "../project.ts";
import { followRun } from "../run-follow.ts";
import { withStoreClient } from "../store-client.ts";
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

/** Type-directed coercion of resolved `--input` strings + an optional whole-
 * object `--input-json` against the workflow's `inputs:` declarations.
 *
 * - `--input-json` (if present) is parsed as one JSON value and seeds the map.
 * - Each `--input name=value` overlays it: an object / array-typed input has its
 *   string `JSON.parse`d; a scalar stays verbatim. Validation against the
 *   declared profile happens downstream at enqueue (`validateInputBindings`).
 * - Malformed JSON for a declared object / array input (or for `--input-json`)
 *   throws a clean error naming the offender — never a silent coercion.
 */
export function coerceInputs(
  rawStrings: Record<string, string>,
  inputJson: string | undefined,
  decls: readonly InputDecl[],
): Record<string, unknown> {
  const declByName = new Map(decls.map((d) => [d.name, d]));
  const out: Record<string, unknown> = {};
  if (inputJson !== undefined) {
    let whole: unknown;
    try {
      whole = JSON.parse(inputJson);
    } catch (err) {
      throw new Error(`--input-json is not valid JSON: ${(err as Error).message}`);
    }
    if (whole === null || typeof whole !== "object" || Array.isArray(whole)) {
      throw new Error("--input-json must be a JSON object mapping input names to values");
    }
    // Copy only own, non-dunder keys: `Object.assign(out, ...)` would invoke the
    // `__proto__` setter for a `{"__proto__": ...}` payload, polluting `out`'s
    // prototype chain so the bracket-reads in `resolveInputBindings` /
    // `validateInputBindings` see an attacker value the own-only `unknown_input`
    // check never reports.
    for (const [k, v] of Object.entries(whole as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = v;
    }
  }
  for (const [name, value] of Object.entries(rawStrings)) {
    const decl = declByName.get(name);
    if (decl !== undefined && (decl.type === "object" || decl.type === "array")) {
      try {
        out[name] = JSON.parse(value);
      } catch (err) {
        throw new Error(`input "${name}" (type ${decl.type}) is not valid JSON: ${(err as Error).message}`);
      }
    } else {
      out[name] = value;
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
      inputs = coerceInputs(opts.inputs ?? {}, opts.inputJson, inputDecls);
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

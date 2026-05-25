// `fragua ci <workflow>` — the one-shot embedded executor. Unlike every other
// CLI verb (pure store-clients that write an intent and return), `ci` embeds
// the executor in-process and writes `fact.*` itself: open an ephemeral store,
// seed credentials from env, save + enqueue the workflow, drive the run to a
// stop-state, render the event log, and exit with a code that reflects the
// outcome (see `../cli-exit.ts` for the total status → exit-code map). The
// `.db` is a portable artifact.
//
// Pause policy: the drive loop CONTINUES the `paused_auto` arm — the
// daemon-owed clock tick (provider_retry / handler_retry / timeout_retry) —
// honouring its backoff and re-claiming, exactly as the daemon would. It only
// STOPS (non-zero exit) on a terminal state or an unanswerable pause: `paused`
// (operator action), `paused_human` (HITL), `quarantined`. CI has no responder
// for those. Run in the checkout via a per-run worktree (git cwd) /
// LocalEnvironment (non-git cwd). Pluggable HITL and cross-machine import are
// deferred (docs/proposals/hitl-channel.md, db-import.md).

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTO_RESUME_AT_KEY } from "@fragua/core";
import { makeIntentPlane } from "@fragua/core/intent-plane";
import { makeReadPlane } from "@fragua/core/read-plane";
import { AbortRegistry, type ExecutorOpts, runOne, WorktreeProvisioner, wakePending } from "@fragua/daemon";
import { type IEventStore, newRunId, SqliteStore, type StoredEvent } from "@fragua/store";
import type { HaltReason, PauseReason, QuarantineReason } from "@fragua/types";
import chalk from "chalk";
import { driveCiRun } from "../ci-drive.ts";
import { CLI_EXIT, type StopReason, cliExitCode } from "../cli-exit.ts";
import { loadConfig, resolveTimeouts } from "../config.ts";
import { seedCredsFromEnv } from "../env-creds.ts";
import { buildExecutorDeps } from "../executor-deps.ts";
import { resolveProject } from "../project.ts";
import { renderEvent } from "../run-follow.ts";
import { globalWorkflowsDir, projectWorkflowsDir, resolveWorkflow } from "../workflow-path.ts";

const POLL_MS = 50;
const BATCH = 500;

export interface CiCommandOptions {
  workflow: string;
  /** Ephemeral store path. Default: a temp dir (discarded on exit). Pin with
   * `--db` to keep the run as a portable artifact. */
  dbPath?: string;
  /** Typed run inputs (`--input name=value`). */
  inputs?: Record<string, string>;
  /** Emit the event log as JSONL instead of the human render. */
  json?: boolean;
  /** Provider/model override (else config defaults, else env-autodetect). */
  provider?: string;
  model?: string;
  /** Base directory used to resolve the workflow + project identity. Default cwd. */
  cwd?: string;
}

/** Wall-clock ms at which a `paused_auto` run becomes wake-eligible, read
 * from `routing.internal.auto_resume_at` (set by the engine when it parks
 * the run for `provider_retry` / `handler_retry` / `timeout_retry`).
 * `undefined` if the run isn't auto-paused or the key is missing. */
function autoResumeAt(store: IEventStore, runId: string): number | undefined {
  const v = store.getState(runId)?.routing[AUTO_RESUME_AT_KEY];
  return typeof v === "number" ? v : undefined;
}

/** Sleep until `wakeAt` (ms epoch), waking early on shutdown. Floored at
 * `POLL_MS` so a stale/past timestamp can't spin the drive loop. */
async function sleepUntil(wakeAt: number | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const delay = wakeAt === undefined ? POLL_MS : Math.max(POLL_MS, wakeAt - Date.now());
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function ciCommand(opts: CiCommandOptions): Promise<number> {
  const invocationCwd = opts.cwd ?? process.cwd();
  const project = await resolveProject(invocationCwd);
  const cwd = project.projectRoot;

  const resolved = await resolveWorkflow(cwd, opts.workflow);
  if (resolved == null) {
    const looksLikePath = opts.workflow.includes("/") || opts.workflow.endsWith(".yaml");
    if (looksLikePath) {
      console.error(chalk.red(`ci: workflow not found: ${opts.workflow} (resolved as path)`));
    } else {
      console.error(chalk.red(`ci: workflow not found: ${opts.workflow}`));
      console.error(
        chalk.dim(
          `  looked in ${globalWorkflowsDir()}/${opts.workflow}.yaml, then ${projectWorkflowsDir(cwd)}/${opts.workflow}.yaml`,
        ),
      );
    }
    return CLI_EXIT.usage;
  }
  const { dotPath, name, scope } = resolved;

  let source: string;
  try {
    source = await readFile(dotPath, "utf8");
  } catch (err) {
    console.error(chalk.red(`ci: cannot read ${dotPath}: ${(err as Error).message}`));
    return CLI_EXIT.usage;
  }

  // Ephemeral store: --db-pinned (portable artifact) or a temp dir. A fresh
  // path is created at the baseline schema (SqliteStore migrates by default).
  let storeDir: string | undefined;
  let storePath: string;
  if (opts.dbPath) {
    storePath = resolve(opts.dbPath);
  } else {
    storeDir = mkdtempSync(join(tmpdir(), "fragua-ci-"));
    storePath = join(storeDir, "fragua.db");
  }
  const store = new SqliteStore({ path: storePath });
  const shutdown = new AbortController();
  const onSig = () => shutdown.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  const provisioner = new WorktreeProvisioner({ repoRoot: cwd });
  let runId: string | undefined;

  try {
    // Seed credentials from env (ANTHROPIC_API_KEY, …), then assemble the
    // executor from the same factory the daemon uses.
    const seeded = seedCredsFromEnv(store);
    const config = await loadConfig(cwd);
    let timeouts: ReturnType<typeof resolveTimeouts>;
    try {
      timeouts = resolveTimeouts(config);
    } catch (err) {
      console.error(chalk.red(`ci: ${(err as Error).message}`));
      return CLI_EXIT.usage;
    }
    const deps = await buildExecutorDeps({
      store,
      cwd,
      config,
      timeouts,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    });
    if (!deps.llm.useLlm) {
      const hint = seeded.length > 0 ? `creds seeded for ${seeded.join(", ")}` : "no provider creds found in env";
      console.error(chalk.yellow(`ci: no llm provider resolved (${hint}); llm nodes will use the stub backend`));
    }

    const plane = makeIntentPlane({ store, newRunId });
    const readPlane = makeReadPlane({ store });

    // Save (content-addressed) + enqueue — the same save-then-enqueue every
    // caller routes through (intent-plane §3.1). A CI store starts fresh, so
    // the workflow is never already present.
    const mint = plane.buildSaveWorkflow(source);
    if (!mint.ok) {
      console.error(chalk.red(`ci: ${opts.workflow} did not parse: ${mint.detail}`));
      return CLI_EXIT.usage;
    }
    plane.commitSaveWorkflow({ sha: mint.sha, name, source, ir: mint.ir, irVersion: mint.irVersion });
    const enq = plane.buildEnqueue({
      workflowSha: mint.sha,
      inputDecls: mint.graph.attrs.inputs ?? [],
      cwd: resolve(cwd),
      projectId: project.projectId,
      projectName: project.projectName,
      workflowScope: scope,
      workflowPath: dotPath,
      ...(scope === "global" || scope === "local" ? { workflowName: name } : {}),
      ...(opts.inputs !== undefined && Object.keys(opts.inputs).length > 0 ? { inputs: opts.inputs } : {}),
    });
    if (!enq.ok) {
      console.error(chalk.red(`ci: ${enq.error}`));
      return CLI_EXIT.usage;
    }
    plane.commitEnqueue(enq.params);
    runId = enq.runId;
    const rid = runId;

    const execOpts: ExecutorOpts = {
      store,
      dispatcher: deps.dispatcher,
      registry: new AbortRegistry(),
      tools: deps.tools,
      llmCall: deps.llmCall,
      maxConcurrentRuns: 1,
      shutdownSignal: shutdown.signal,
      provisioner,
      graphLoader: deps.graphLoader,
    };
    if (timeouts.leakGrace !== undefined) execOpts.leakGraceMs = timeouts.leakGrace;

    // Fiber A: drive the run (see `driveCiRun` — continues paused_auto, stops
    // on terminal/unanswerable-pause). Fiber B (this loop): tail the store and
    // render. The tailer reads the store, not the executor, so `ci` and
    // `fragua run --follow` share one rendering path and can't drift. One
    // bun:sqlite handle: SQLite calls are sync and fibers yield only at await,
    // so write/poll interleave safely.
    let execDone = false;
    const exec = driveCiRun({
      shutdownSignal: shutdown.signal,
      wake: () => wakePending(store),
      claimAndDispatch: async () => {
        const claimed = store.claimNextRun(1);
        if (claimed?.runId !== rid) return false;
        await runOne(rid, execOpts);
        return true;
      },
      status: () => store.getState(rid)?.status,
      autoResumeAt: () => autoResumeAt(store, rid),
      sleepUntil: (wakeAt) => sleepUntil(wakeAt, shutdown.signal),
    });
    const execSettled = exec.finally(() => {
      execDone = true;
    });

    // Capture the terminal reason as it streams past — it selects the
    // per-reason exit code for the stop-state (one code per HaltReason /
    // PauseReason / QuarantineReason; see `../cli-exit.ts`).
    const stopReason: StopReason = {};
    const emit = (ev: StoredEvent) => {
      const r = (ev.payload as { reason?: string } | null)?.reason;
      if (r !== undefined) {
        if (ev.type === "fact.run_halted") stopReason.halt = r as HaltReason;
        else if (ev.type === "fact.run_paused") stopReason.pause = r as PauseReason;
        else if (ev.type === "fact.run_quarantined") stopReason.quarantine = r as QuarantineReason;
      }
      if (opts.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
      else renderEvent(ev);
    };
    let cursor = 0;
    for (;;) {
      const batch = readPlane.eventsSince(rid, cursor, BATCH);
      for (const ev of batch) {
        emit(ev);
        cursor = ev.seq;
      }
      if (execDone) {
        // Drain events committed after the executor returned (the terminal
        // fact lands last), then stop.
        const tail = readPlane.eventsSince(rid, cursor, BATCH);
        for (const ev of tail) {
          emit(ev);
          cursor = ev.seq;
        }
        break;
      }
      if (batch.length < BATCH) await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await execSettled; // surface a driver throw after the log has drained

    // A SIGINT/SIGTERM-interrupted drive is a cancellation regardless of the
    // status the run happened to be parked in when the signal fired.
    if (shutdown.signal.aborted) return CLI_EXIT.cancelled;

    const status = store.getState(rid)?.status ?? "halted";
    const code = cliExitCode(status, stopReason);
    if (status === "halted") {
      console.error(chalk.red(`ci: run halted (${stopReason.halt ?? "error"}) — exit ${code}`));
    } else if (status === "paused") {
      console.error(
        chalk.yellow(`ci: run needs an operator (paused: ${stopReason.pause ?? "operator"}) — no responder in CI`),
      );
    } else if (status === "paused_human") {
      console.error(chalk.yellow(`ci: run is waiting on human input (paused_human) — no responder in CI`));
    } else if (status === "quarantined") {
      console.error(
        chalk.yellow(`ci: run quarantined (${stopReason.quarantine ?? "other"}) — needs manual resolution`),
      );
    } else if (status === "queued" || status === "running" || status === "paused_auto") {
      console.error(chalk.red(`ci: driver stopped on a non-terminal status (${status}) — this is a ci bug`));
    }
    return code;
  } catch (err) {
    console.error(chalk.red(`ci: ${(err as Error).message}`));
    return CLI_EXIT.usage;
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
    // Best-effort: runOne disposes the worktree on terminal; this covers the
    // pause / error paths where it doesn't.
    if (runId !== undefined) {
      try {
        await provisioner.dispose(runId);
      } catch {
        // already disposed, or never provisioned — nothing to clean up.
      }
    }
    store.close();
    if (storeDir !== undefined) rmSync(storeDir, { recursive: true, force: true });
  }
}

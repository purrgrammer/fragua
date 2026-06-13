// `fragua runs wait <id...>` — block until a set of runs reaches a settled
// state, replacing hand-rolled `while fragua runs ls | grep` polling loops.
//
// A store-client read-loop (no HTTP): polls the read plane's run-status
// projection on an interval, prints each lifecycle transition as it happens
// (one line per run per change), and exits through the shared `cliExitCode`
// map — so a fleet wait carries the same banded outcome detail as `fragua ci`
// / `fragua run --follow`. Selection is one of: explicit ids, every active run
// of a `--workflow`, or `--all-running`. `--settle` chooses whether a blocked
// (paused / paused_human) run counts as done; the default is `blocked`, because
// an operator wait wants to stop the moment a run needs them.

import { resolve } from "node:path";
import type { ReadPlane } from "@fragua/core/read-plane";
import type { RunStatus } from "@fragua/store";
import type { HaltReason, PauseReason, QuarantineReason } from "@fragua/types";
import chalk from "chalk";
import { CLI_EXIT, cliExitCode } from "../cli-exit.ts";
import { withStoreClient } from "../store-client.ts";

/** Default poll cadence. Runs change on the order of seconds, not ms, so a
 * coarse interval keeps the read-loop cheap; tests pass a small override. */
const WAIT_POLL_MS = 1000;

/** Cap on the run set a selector (`--workflow` / `--all-running`) resolves. */
const SELECT_LIMIT = 1000;

export type SettleMode = "terminal" | "blocked";

/** Terminal lifecycle statuses — the run is done for good. */
const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "halted", "cancelled", "quarantined"]);
/** Blocked-on-operator statuses — the run needs a human to proceed.
 * `paused_auto` is deliberately absent: the daemon owns its wake, so a wait
 * keeps polling through it in both settle modes. */
const BLOCKED_STATUSES = new Set<RunStatus>(["paused", "paused_human"]);

function isSettled(status: RunStatus, mode: SettleMode): boolean {
  if (TERMINAL_STATUSES.has(status)) return true;
  return mode === "blocked" && BLOCKED_STATUSES.has(status);
}

/** Worst-outcome rank: a halt/quarantine dominates a cancel, which dominates a
 * block, which dominates a clean completion. The set's aggregate exit code is
 * the highest-ranked run's `cliExitCode`. */
function severity(status: RunStatus): number {
  if (status === "halted" || status === "quarantined") return 3;
  if (status === "cancelled") return 2;
  if (status === "paused" || status === "paused_human") return 1;
  return 0;
}

export interface WaitOptions {
  /** Explicit run ids to wait on. Mutually exclusive with the selectors. */
  ids?: string[];
  /** Select every currently-active run of this workflow (by name). */
  workflow?: string;
  /** Select every currently-active run (queued / running / paused_auto, plus
   * paused / paused_human under `--settle terminal`). */
  allRunning?: boolean;
  /** Give up after this duration (e.g. `30s`, `5m`, `1h`); exit `timeout`. */
  timeout?: string;
  /** Whether a blocked run counts as settled. Default `blocked`. */
  settle?: string;
  /** Project root scoping the `--workflow` / `--all-running` selectors. */
  cwd?: string;
  /** Store path. Default `~/.fragua/fragua.db`. */
  dbPath?: string;
  /** Test hook — poll cadence override. */
  pollMs?: number;
}

/** Parse a `--timeout` duration into ms. Supports ms / s / m / h / d; no
 * default (the flag is optional at the call site) and throws on bad input. */
export function parseTimeout(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/i.exec(input.trim());
  if (match == null) {
    throw new Error(`invalid --timeout "${input}" — expected forms like 30s, 5m, 1h, 2d`);
  }
  const n = Number.parseInt(match[1] ?? "0", 10);
  switch ((match[2] ?? "").toLowerCase()) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    default:
      return n * 24 * 60 * 60 * 1000;
  }
}

function statusColor(status: RunStatus): string {
  if (status === "completed") return chalk.green(status);
  if (status === "halted" || status === "cancelled" || status === "quarantined") return chalk.red(status);
  if (status === "paused" || status === "paused_human" || status === "paused_auto") return chalk.yellow(status);
  return chalk.dim(status);
}

/** The exit code for one settled run, with its terminal/pause reason pulled off
 * the matching fact (mirrors `run-follow.ts`'s `followExitCode`). */
function settledExitCode(readPlane: ReadPlane, runId: string, status: RunStatus): number {
  const events = readPlane.events(runId) ?? [];
  const reasonOf = (type: string): string | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type === type) return (ev.payload as { reason?: string }).reason;
    }
    return undefined;
  };
  switch (status) {
    case "halted": {
      const r = reasonOf("fact.run_halted");
      return cliExitCode("halted", r ? { halt: r as HaltReason } : {});
    }
    case "quarantined": {
      const r = reasonOf("fact.run_quarantined");
      return cliExitCode("quarantined", r ? { quarantine: r as QuarantineReason } : {});
    }
    case "paused": {
      const r = reasonOf("fact.run_paused");
      return cliExitCode("paused", r ? { pause: r as PauseReason } : {});
    }
    case "paused_human":
      return cliExitCode("paused_human");
    case "cancelled":
      return cliExitCode("cancelled");
    default:
      return cliExitCode("completed");
  }
}

function aggregateExit(readPlane: ReadPlane, ids: string[]): number {
  let bestSev = -1;
  let code: number = CLI_EXIT.ok;
  for (const id of ids) {
    const status = readPlane.runDetail(id)?.runStatus;
    if (status == null) continue;
    const sev = severity(status);
    if (sev > bestSev) {
      bestSev = sev;
      code = settledExitCode(readPlane, id, status);
    }
  }
  return code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve the run set from the selectors. Returns the ids, or `null` after
 * printing an actionable error (caller exits 1). */
function resolveIds(readPlane: ReadPlane, opts: WaitOptions, mode: SettleMode): string[] | null {
  const explicit = opts.ids ?? [];
  const selectors = [explicit.length > 0, opts.workflow != null, opts.allRunning === true].filter(Boolean).length;
  if (selectors === 0) {
    console.error(chalk.red("wait: select runs — pass <id...>, --workflow <name>, or --all-running"));
    return null;
  }
  if (selectors > 1) {
    console.error(chalk.red("wait: choose one of <id...>, --workflow <name>, --all-running"));
    return null;
  }
  if (explicit.length > 0) {
    const missing = explicit.filter((id) => readPlane.runDetail(id) == null);
    if (missing.length > 0) {
      console.error(chalk.red(`wait: run not found`) + chalk.dim(` (${missing.join(", ")})`));
      return null;
    }
    return explicit;
  }
  const cwd = resolve(opts.cwd ?? process.cwd());
  const rows = readPlane.runSummaries({ cwd, order: "newest", limit: SELECT_LIMIT });
  return rows
    .filter((r) => (opts.workflow != null ? r.workflowName === opts.workflow : true))
    .filter((r) => r.runStatus != null && !isSettled(r.runStatus, mode))
    .map((r) => r.runId);
}

export function waitCommand(opts: WaitOptions): Promise<number> {
  if (opts.settle != null && opts.settle !== "terminal" && opts.settle !== "blocked") {
    console.error(chalk.red(`wait: --settle must be "terminal" or "blocked" (got "${opts.settle}")`));
    return Promise.resolve(1);
  }
  const mode: SettleMode = opts.settle === "terminal" ? "terminal" : "blocked";
  let timeoutMs: number | undefined;
  if (opts.timeout != null) {
    try {
      timeoutMs = parseTimeout(opts.timeout);
    } catch (err) {
      console.error(chalk.red(`wait: ${(err as Error).message}`));
      return Promise.resolve(1);
    }
  }
  const pollMs = opts.pollMs ?? WAIT_POLL_MS;

  return withStoreClient(opts, async ({ readPlane }) => {
    const ids = resolveIds(readPlane, opts, mode);
    if (ids == null) return 1;
    if (ids.length === 0) {
      console.log(chalk.dim("wait: nothing to wait on (no matching unsettled runs)"));
      return CLI_EXIT.ok;
    }

    const deadline = timeoutMs != null ? Date.now() + timeoutMs : undefined;
    const lastStatus = new Map<string, RunStatus>();
    for (;;) {
      let allSettled = true;
      for (const id of ids) {
        const status = readPlane.runDetail(id)?.runStatus;
        if (status == null) continue;
        const prev = lastStatus.get(id);
        if (prev !== undefined && prev !== status) {
          console.log(`${chalk.cyan(id)}  ${chalk.dim(prev)} → ${statusColor(status)}`);
        }
        lastStatus.set(id, status);
        if (!isSettled(status, mode)) allSettled = false;
      }
      if (allSettled) return aggregateExit(readPlane, ids);
      if (deadline != null && Date.now() >= deadline) {
        const pending = ids.filter((id) => {
          const s = readPlane.runDetail(id)?.runStatus;
          return s != null && !isSettled(s, mode);
        });
        console.error(
          chalk.red(`wait: timed out after ${opts.timeout}`) + chalk.dim(` — still unsettled: ${pending.join(", ")}`),
        );
        return CLI_EXIT.timeout;
      }
      await sleep(pollMs);
    }
  });
}

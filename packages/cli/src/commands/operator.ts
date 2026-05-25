// `fragua runs <verb>` — operator primitives.
//
// Writes (steer/pause/cancel/resume/respond/unquarantine/priority/budget/
// max-retries/goal-gate/max-loops, plus accept/discard) are direct
// store-clients: open the store, write through the intent plane (accept/discard
// additionally run the shared `@fragua/workspace` git action first). No server
// needed, works daemon-down.
//
// Reads (ls/inbox/diff) are also direct store-clients via the read plane; `diff`
// resolves the commit range through `readPlane.diffRange` and runs the git diff
// inline with the same `@fragua/workspace` `gitDiff` the server uses.

import { resolve } from "node:path";
import type { BuildResult, IntentPlane } from "@fragua/core/intent-plane";
import type { DiffRange } from "@fragua/core/read-plane";
import type { RunStatus, SqliteStore } from "@fragua/store";
import { applyAccept, applyDiscard, defaultGitExec, gitDiff, type RunActionGate } from "@fragua/workspace";
import chalk from "chalk";
import { pickRoute } from "../route-picker.ts";
import { withStoreClient } from "../store-client.ts";

interface DiscoveryOpts {
  url?: string;
  cwd?: string;
  dbPath?: string;
}

/** Write a control intent through the plane against the local store. Checks
 * the run exists, builds + validates via the plane, commits, prints the seq. */
function writeIntent(
  opts: DiscoveryOpts,
  runId: string,
  verb: string,
  build: (plane: IntentPlane) => BuildResult,
): Promise<number> {
  return withStoreClient(opts, ({ store, plane }) => {
    if (store.getState(runId) == null) {
      console.error(chalk.red(`${verb}: run not found`) + chalk.dim(` (${runId})`));
      return 1;
    }
    const built = build(plane);
    if (!built.ok) {
      console.error(chalk.red(`${verb}: ${built.error}`));
      return 1;
    }
    try {
      const { seq } = plane.commit(runId, built.intent);
      console.log(chalk.green(`${verb} requested`) + chalk.dim(` (run ${runId}, intent seq ${seq})`));
      return 0;
    } catch (err) {
      console.error(chalk.red(`${verb}: ${(err as Error).message}`));
      return 1;
    }
  });
}

export interface DiscardOptions extends DiscoveryOpts {
  runId: string;
}

export function discardCommand(opts: DiscardOptions): Promise<number> {
  return withStoreClient(opts, async ({ store, plane }) => {
    const gate = readGate(store, opts.runId);
    if (gate == null) {
      console.error(chalk.red("discard: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const res = await applyDiscard(defaultGitExec, gate);
    if (!res.ok) {
      console.error(chalk.red(`discard: ${res.detail}`) + chalk.dim(` [${res.reason}]`));
      return 1;
    }
    plane.commit(opts.runId, plane.buildDiscardRun(res));
    console.log(chalk.green("discarded") + chalk.dim(` (run ${opts.runId})`));
    return 0;
  });
}

export interface AcceptOptions extends DiscoveryOpts {
  runId: string;
}

export function acceptCommand(opts: AcceptOptions): Promise<number> {
  return withStoreClient(opts, async ({ store, plane }) => {
    const gate = readGate(store, opts.runId);
    if (gate == null) {
      console.error(chalk.red("accept: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    // Replay synchronously against the local worktree, then record the result
    // as intent.accept_run via the plane (the daemon folds it into the inbox
    // projection). The state gate is inside applyAccept (§3.7).
    const res = await applyAccept(defaultGitExec, gate);
    if (!res.ok) {
      console.error(chalk.red(`accept: ${res.detail}`) + chalk.dim(` [${res.reason}]`));
      return 1;
    }
    plane.commit(opts.runId, plane.buildAcceptRun(res));
    const tail = res.tailStaged ? "; tail staged — `git commit` when ready" : "";
    console.log(chalk.green("accepted") + chalk.dim(` (run ${opts.runId}, replayed ${res.replayed}${tail})`));
    return 0;
  });
}

/** Build the run-action gate from run_state, or null if the run doesn't exist.
 * The state preconditions (terminal / inbox / worktree) are checked inside the
 * workspace action — this only assembles the inputs (§3.7). */
function readGate(store: SqliteStore, runId: string): RunActionGate | null {
  const state = store.getState(runId);
  if (state == null) return null;
  return {
    runId,
    status: state.status,
    inboxStatus: state.inboxStatus,
    cwd: state.cwd,
    baseGitSha: state.baseGitSha ?? "",
  };
}

interface InboxRunRow {
  runId: string;
  title?: string;
  runStatus?: string;
  changeStat?: {
    committed: { filesChanged: number; insertions: number; deletions: number } | null;
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null;
  };
}

export interface InboxOptions extends DiscoveryOpts {
  limit?: number;
}

const BLOCKED_STATUSES: RunStatus[] = ["paused_human", "paused", "paused_auto", "quarantined"];

function titleOf(r: InboxRunRow): string {
  return r.title != null && r.title.length > 0 ? r.title : chalk.dim("(untitled)");
}

function changeBadge(r: InboxRunRow): string {
  const stat = r.changeStat?.committed ?? r.changeStat?.uncommitted ?? null;
  if (stat == null) return "";
  return ` ${chalk.dim(`(${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"}, `)}${chalk.green(`+${stat.insertions}`)}${chalk.dim(" / ")}${chalk.red(`−${stat.deletions}`)}${chalk.dim(")")}`;
}

/** Suggested verb for a blocked run, by lifecycle status. */
function blockedVerb(runStatus?: string): string {
  if (runStatus === "paused_human") return "respond";
  if (runStatus === "quarantined") return "unquarantine";
  return "resume"; // paused | paused_auto
}

/**
 * Two-section operator inbox, mirroring the web /inbox:
 *   NEEDS INPUT  — blocked runs (HITL / paused / quarantined) → unblock so
 *                  the run continues (respond / resume / unquarantine).
 *   READY TO LAND — terminal runs with recoverable work → land the output
 *                  (accept / discard).
 */
export function inboxCommand(opts: InboxOptions): Promise<number> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  return withStoreClient(opts, ({ readPlane }) => {
    const common = { cwd, order: "oldest" as const, ...(opts.limit != null ? { limit: opts.limit } : {}) };
    const blocked = readPlane.runSummaries({ ...common, statuses: BLOCKED_STATUSES });
    const ready = readPlane.runSummaries({ ...common, inbox: "pending" });
    return renderInbox(blocked, ready);
  });
}

function renderInbox(blocked: InboxRunRow[], ready: InboxRunRow[]): number {
  if (blocked.length === 0 && ready.length === 0) {
    console.log(chalk.dim("inbox: nothing awaiting an operator decision"));
    return 0;
  }
  if (blocked.length > 0) {
    console.log(chalk.bold(`NEEDS INPUT (${blocked.length})`));
    for (const r of blocked) {
      console.log(
        `  ${chalk.cyan(r.runId)}  ${titleOf(r)} ${chalk.yellow(`· ${r.runStatus ?? "?"}`)} ${chalk.dim(`→ fragua runs ${blockedVerb(r.runStatus)}`)}`,
      );
    }
  }
  if (ready.length > 0) {
    console.log(chalk.bold(`READY TO LAND (${ready.length})`));
    for (const r of ready) {
      console.log(
        `  ${chalk.cyan(r.runId)}  ${titleOf(r)}${changeBadge(r)} ${chalk.dim("→ fragua runs accept|discard")}`,
      );
    }
  }
  return 0;
}

export interface RespondOptions extends DiscoveryOpts {
  runId: string;
  route?: string;
  note?: string;
}

/** Respond to a `paused_human` HITL gate. With `--route` it posts directly
 * (scriptable); without, it shows the gate prompt + routes and reads a choice
 * from stdin (interactive). */
export async function respondCommand(opts: RespondOptions): Promise<number> {
  return withStoreClient(opts, async ({ store, plane }) => {
    const state = store.getState(opts.runId);
    if (state == null) {
      console.error(chalk.red("respond: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (state.status !== "paused_human") {
      console.error(chalk.red(`respond: run is not at a HITL gate (status=${state.status})`));
      return 1;
    }
    // The gate's routes + prompt + label overrides live on the last
    // fact.run_paused_human.
    let routes: string[] = [];
    let routeLabels: Record<string, string> = {};
    let label = "Choose how to proceed";
    const events = store.getEvents(opts.runId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.type === "fact.run_paused_human") {
        const p = events[i]!.payload as { text?: string; routes?: string[]; routeLabels?: Record<string, string> };
        routes = p.routes ?? [];
        routeLabels = p.routeLabels ?? {};
        label = p.text ?? label;
        break;
      }
    }
    let route = opts.route;
    if (route == null) {
      // Interactive: arrow-key select of human-readable route names.
      route = await pickRoute(routes, routeLabels, label);
      if (route === undefined) {
        console.error(chalk.red("respond: no choice made (pass --route to script it)"));
        return 1;
      }
    } else if (routes.length > 0 && !routes.includes(route)) {
      console.error(chalk.red(`respond: unknown route "${route}" (expected one of: ${routes.join(", ")})`));
      return 1;
    }
    const body: { route: string; note?: string } = { route };
    if (opts.note != null && opts.note.length > 0) body.note = opts.note;
    const built = plane.buildHuman(body);
    if (!built.ok) {
      console.error(chalk.red(`respond: ${built.error}`));
      return 1;
    }
    const { seq } = plane.commit(opts.runId, built.intent);
    console.log(chalk.green("human input recorded") + chalk.dim(` (run ${opts.runId}, intent seq ${seq})`));
    return 0;
  });
}

export interface ResumeOptions extends DiscoveryOpts {
  runId: string;
  note?: string;
}

export function resumeCommand(opts: ResumeOptions): Promise<number> {
  const body: { note?: string } = {};
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "resume", (p) => p.buildResume(body));
}

export interface CancelOptions extends DiscoveryOpts {
  runId: string;
  reason?: string;
}

export function cancelCommand(opts: CancelOptions): Promise<number> {
  const body: { reason?: string } = {};
  if (opts.reason != null && opts.reason.length > 0) body.reason = opts.reason;
  return writeIntent(opts, opts.runId, "cancel", (p) => p.buildCancel(body));
}

export interface UnquarantineOptions extends DiscoveryOpts {
  runId: string;
  resolution?: string;
  note?: string;
}

export function unquarantineCommand(opts: UnquarantineOptions): Promise<number> {
  const r = opts.resolution;
  if (r !== "treat_as_done" && r !== "retry" && r !== "cancel") {
    console.error(chalk.red("unquarantine: --resolution treat_as_done|retry|cancel required"));
    return Promise.resolve(1);
  }
  const body: { resolution: string; note?: string } = { resolution: r };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "unquarantine", (p) => p.buildUnquarantine(body));
}

export interface SteerOptions extends DiscoveryOpts {
  runId: string;
  text: string;
}

/** Inject a steering nudge: aborts the current handler and re-dispatches the
 * node with the text prepended to the next LLM call's thread. */
export function steerCommand(opts: SteerOptions): Promise<number> {
  if (opts.text.trim().length === 0) {
    console.error(chalk.red("steer: <text> required"));
    return Promise.resolve(1);
  }
  return writeIntent(opts, opts.runId, "steer", (p) => p.buildSteer({ text: opts.text }));
}

export interface PauseOptions extends DiscoveryOpts {
  runId: string;
}

/** Pause a running run (operator). Aborts the current handler; resume with `resume`. */
export function pauseCommand(opts: PauseOptions): Promise<number> {
  return writeIntent(opts, opts.runId, "pause", (p) => p.buildPause({}));
}

export interface PriorityOptions extends DiscoveryOpts {
  runId: string;
  newPriority: number;
  note?: string;
}

/** Re-order a queued run (higher runs first). Already-running runs unaffected. */
export function priorityCommand(opts: PriorityOptions): Promise<number> {
  if (!Number.isFinite(opts.newPriority)) {
    console.error(chalk.red("priority: <newPriority> integer required"));
    return Promise.resolve(1);
  }
  const body: { newPriority: number; note?: string } = { newPriority: opts.newPriority };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "priority", (p) => p.buildPriority(body));
}

export interface BudgetOptions extends DiscoveryOpts {
  runId: string;
  scope?: string;
  metric?: string;
  newLimit?: number;
  note?: string;
}

/** Raise a cap on a `paused{reason:"budget"}` run, then `resume` to continue. */
export function budgetCommand(opts: BudgetOptions): Promise<number> {
  if (opts.scope == null || opts.metric == null || opts.newLimit == null || !Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("budget: --scope <s> --metric <m> --new-limit <n> required"));
    return Promise.resolve(1);
  }
  const body: { scope: string; metric: string; newLimit: number; note?: string } = {
    scope: opts.scope,
    metric: opts.metric,
    newLimit: opts.newLimit,
  };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "budget", (p) => p.buildBudget(body));
}

export interface MaxRetriesOptions extends DiscoveryOpts {
  runId: string;
  nodeId?: string;
  newLimit: number;
  note?: string;
}

/** Raise one node's handler-retry cap on a `paused{reason:"max_retries"}` run, then `resume`. */
export function maxRetriesCommand(opts: MaxRetriesOptions): Promise<number> {
  if (opts.nodeId == null || opts.nodeId.length === 0) {
    console.error(chalk.red("max-retries: --node <nodeId> required"));
    return Promise.resolve(1);
  }
  if (!Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("max-retries: <newLimit> integer required"));
    return Promise.resolve(1);
  }
  const body: { nodeId: string; newLimit: number; note?: string } = {
    nodeId: opts.nodeId,
    newLimit: opts.newLimit,
  };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "max-retries", (p) => p.buildMaxRetries(body));
}

export interface GoalGateOptions extends DiscoveryOpts {
  runId: string;
  newLimit: number;
  note?: string;
}

/** Raise the goal-gate retry cap on a `paused{reason:"goal_gate"}` run, then `resume`. */
export function goalGateCommand(opts: GoalGateOptions): Promise<number> {
  if (!Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("goal-gate: <newLimit> integer required"));
    return Promise.resolve(1);
  }
  const body: { newLimit: number; note?: string } = { newLimit: opts.newLimit };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "goal-gate", (p) => p.buildGoalGate(body));
}

export interface MaxLoopsOptions extends DiscoveryOpts {
  runId: string;
  newLimit: number;
  note?: string;
}

/** Raise the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run, then `resume`. */
export function maxLoopsCommand(opts: MaxLoopsOptions): Promise<number> {
  if (!Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("max-loops: <newLimit> integer required"));
    return Promise.resolve(1);
  }
  const body: { newLimit: number; note?: string } = { newLimit: opts.newLimit };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "max-loops", (p) => p.buildMaxLoops(body));
}

export interface LsOptions extends DiscoveryOpts {
  status?: string;
  limit?: number;
}

/** List runs (optionally filtered by lifecycle status). */
export function lsCommand(opts: LsOptions): Promise<number> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const statuses =
    opts.status != null && opts.status.length > 0
      ? (opts.status
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0) as RunStatus[])
      : undefined;
  return withStoreClient(opts, ({ readPlane }) => {
    const rows = readPlane.runSummaries({
      cwd,
      order: "newest",
      limit: opts.limit ?? 30,
      ...(statuses !== undefined ? { statuses } : {}),
    });
    if (rows.length === 0) {
      console.log(chalk.dim("ls: no runs"));
      return 0;
    }
    for (const r of rows) {
      console.log(`${chalk.cyan(r.runId)}  ${chalk.dim((r.runStatus ?? "?").padEnd(13))} ${titleOf(r)}`);
    }
    return 0;
  });
}

export interface DiffOptions extends DiscoveryOpts {
  runId: string;
  against?: string;
  snap?: number;
  path?: string;
}

export function diffCommand(opts: DiffOptions): Promise<number> {
  return withStoreClient(opts, async ({ readPlane }) => {
    const snapshots = readPlane.snapshots(opts.runId);
    if (snapshots == null) {
      console.error(chalk.red("diff: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (snapshots.length === 0) {
      console.error(chalk.yellow(`diff: run ${opts.runId} has no snapshots (bare-cwd or no worktree)`));
      return 1;
    }
    const eventIdx = opts.snap ?? snapshots[snapshots.length - 1]!.eventIdx;
    const against = opts.against ?? "base";

    const range = readPlane.diffRange(opts.runId, eventIdx, against);
    if (!range.ok) {
      console.error(chalk.red(`diff: ${diffRefusalMessage(range.reason, against)}`) + chalk.dim(` [${range.reason}]`));
      return 1;
    }

    const text = await gitDiff(defaultGitExec, range.cwd, range.fromSha, range.toSha, opts.path);
    if (text.trim() === "") {
      console.log(chalk.dim(`(no changes vs ${against})`));
      return 0;
    }
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  });
}

type DiffRefusal = Extract<DiffRange, { ok: false }>["reason"];

function diffRefusalMessage(reason: DiffRefusal, against: string): string {
  switch (reason) {
    case "run_not_found":
      return "run not found";
    case "no_worktree":
      return "run has no worktree (bare-cwd)";
    case "snapshot_not_found":
      return "no snapshot at that --snap eventIdx";
    case "invalid_against":
      return `--against "${against}" is not "base", "previous", or a snapshot eventIdx`;
    case "base_missing":
      return "run has no recorded base commit to diff against";
  }
}

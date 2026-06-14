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

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BuildResult, IntentPlane } from "@fragua/core/intent-plane";
import type { DiffRange, FleetSummary, RunDetail, RunExplanation, StepSnapshot } from "@fragua/core/read-plane";
import {
  type ArtifactScope,
  type NarrowMessage,
  RUN_STATUSES,
  type RunStatus,
  type SqliteStore,
  type StoredEvent,
} from "@fragua/store";
import { applyAccept, applyDiscard, defaultGitExec, gitDiff, type RunActionGate } from "@fragua/workspace";
import chalk from "chalk";
import { pickRoute } from "../route-picker.ts";
import { followRun, renderEvent } from "../run-follow.ts";
import { withStoreClient } from "../store-client.ts";

interface DiscoveryOpts {
  cwd?: string;
  dbPath?: string;
}

function failedResume(verb: string, runId: string, capSeq: number, error: string): string {
  return (
    chalk.red(`${verb}: cap raised (seq ${capSeq}) but resume failed: ${error}`) +
    chalk.dim(` — run \`fragua runs resume ${runId}\``)
  );
}

/** Write a control intent through the plane against the local store. Checks
 * the run exists, builds + validates via the plane, commits, prints the seq. */
function writeIntent(
  opts: DiscoveryOpts,
  runId: string,
  verb: string,
  build: (plane: IntentPlane) => BuildResult,
  resumeAfter = false,
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
      if (resumeAfter) {
        const resume = plane.buildResume({});
        // Cap raise already persisted: on resume failure point at `resume`, since
        // re-running this verb would commit the cap raise twice.
        if (!resume.ok) {
          console.error(failedResume(verb, runId, seq, resume.error));
          return 1;
        }
        try {
          const r = plane.commit(runId, resume.intent);
          console.log(
            chalk.green(`${verb} requested + resumed`) + chalk.dim(` (run ${runId}, intents seq ${seq}, ${r.seq})`),
          );
          return 0;
        } catch (err) {
          console.error(failedResume(verb, runId, seq, (err as Error).message));
          return 1;
        }
      }
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
  autostash?: boolean;
}

export function acceptCommand(opts: AcceptOptions): Promise<number> {
  return withStoreClient(opts, async ({ store, plane }) => {
    const gate = readGate(store, opts.runId);
    if (gate == null) {
      console.error(chalk.red("accept: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const res = await applyAccept(defaultGitExec, gate, { autostash: opts.autostash === true });
    if (!res.ok) {
      console.error(chalk.red(`accept: ${res.detail}`) + chalk.dim(` [${res.reason}]`));
      return 1;
    }
    plane.commit(opts.runId, plane.buildAcceptRun(res));
    const tail = res.tailStaged ? "; tail staged — `git commit` when ready" : "";
    console.log(chalk.green("accepted") + chalk.dim(` (run ${opts.runId}, replayed ${res.replayed}${tail})`));
    if (res.stashPopConflict === true) {
      console.warn(
        chalk.yellow("accept: autostash pop conflicted with the landed change") +
          chalk.dim(" — your changes are kept in `git stash`; resolve with `git stash pop`"),
      );
    }
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
  input?: string;
  workflowName?: string;
  workflow?: string;
  runStatus?: string;
  changeStat?: {
    committed: { filesChanged: number; insertions: number; deletions: number } | null;
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null;
  };
}

export interface InboxOptions extends DiscoveryOpts {
  limit?: number;
  json?: boolean;
}

/** Statuses a run can sit in while waiting on the operator — the NEEDS INPUT
 * section of the inbox. An intentional non-derivable subset of `RunStatus`
 * (the complement is the unblocked set below); `satisfies` pins membership and
 * the completeness check guarantees the two sets partition `RUN_STATUSES`, so
 * a newly-added lifecycle literal can't silently fall through the inbox.
 * Exported for the enum-consumer drift lint. */
export const BLOCKED_STATUSES = [
  "paused_human",
  "paused",
  "paused_auto",
  "quarantined",
] as const satisfies readonly RunStatus[];

/** The complement of {@link BLOCKED_STATUSES}: statuses that never appear in
 * the NEEDS INPUT section (in-flight or settled). Kept explicit so the
 * completeness check can assert an exact partition of `RUN_STATUSES`. */
export const UNBLOCKED_STATUSES = [
  "queued",
  "running",
  "completed",
  "cancelled",
  "halted",
] as const satisfies readonly RunStatus[];

// Completeness: BLOCKED ⊎ UNBLOCKED must equal RUN_STATUSES exactly. A missing
// literal means a lifecycle status that renders in neither inbox section.
{
  const partitioned = new Set<string>([...BLOCKED_STATUSES, ...UNBLOCKED_STATUSES]);
  const missing = RUN_STATUSES.filter((s) => !partitioned.has(s));
  if (missing.length > 0 || partitioned.size !== RUN_STATUSES.length) {
    throw new Error(
      `operator.ts BLOCKED_STATUSES/UNBLOCKED_STATUSES drifted from RUN_STATUSES: missing ${JSON.stringify(missing)}`,
    );
  }
}

/** Display label for a run, mirroring the web's `displayTitle` fallback
 * (RunRow.tsx): generated title → workflow name. `run_state.title` is only
 * materialised once the summariser runs, so a run with no auto-title (no
 * summariser configured, blip, or `auto-title: false`) falls back to the
 * workflow name rather than reading "(untitled)". */
function titleOf(r: InboxRunRow): string {
  if (r.title != null && r.title.length > 0) return r.title;
  return r.workflowName ?? r.workflow ?? chalk.dim("(untitled)");
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
    const blocked = readPlane.runSummaries({ ...common, statuses: [...BLOCKED_STATUSES] });
    const ready = readPlane.runSummaries({ ...common, inbox: "pending" });
    if (opts.json === true) {
      console.log(JSON.stringify({ needsInput: blocked, readyToLand: ready }, null, 2));
      return 0;
    }
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

export interface StatusOptions extends DiscoveryOpts {
  runId: string;
  json?: boolean;
}

/** Single-run detail: lifecycle + outcome, workflow, cost/tokens, change-stat,
 * and the "why" — the pause reason (+ which cap to raise), halt reason, or
 * quarantine orphans — read off the run's events. Also surfaces any active
 * soft budget warnings (80% mark, before the hard pause). */
export function statusCommand(opts: StatusOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const detail = readPlane.runDetail(opts.runId);
    if (detail == null) {
      console.error(chalk.red("status: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const events = readPlane.events(opts.runId) ?? [];
    if (opts.json === true) {
      const budgetWarns = collectActiveBudgetWarns(events);
      console.log(JSON.stringify({ ...detail, budgetWarns }, null, 2));
      return 0;
    }
    renderStatus(detail, events);
    return 0;
  });
}

/** Collect budget.warn events that have no later budget.stop for the same
 * (scope, metric) pair — still-active soft budget warnings. */
function collectActiveBudgetWarns(
  events: StoredEvent[],
): Array<{ scope: string; metric: string; limit: number; actual: number; ratio: number }> {
  const stopSeqByTag = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "budget.stop") {
      const p = ev.payload as { scope?: unknown; metric?: unknown };
      if (typeof p.scope === "string" && typeof p.metric === "string") {
        stopSeqByTag.set(`${p.scope}:${p.metric}`, ev.seq);
      }
    }
  }
  const warns: Array<{ scope: string; metric: string; limit: number; actual: number; ratio: number }> = [];
  for (const ev of events) {
    if (ev.type !== "budget.warn") continue;
    const p = ev.payload as { scope?: unknown; metric?: unknown; limit?: unknown; actual?: unknown; ratio?: unknown };
    if (typeof p.scope !== "string" || typeof p.metric !== "string") continue;
    const tag = `${p.scope}:${p.metric}`;
    const stopSeq = stopSeqByTag.get(tag);
    if (stopSeq !== undefined && stopSeq > ev.seq) continue;
    warns.push({
      scope: p.scope,
      metric: p.metric,
      limit: typeof p.limit === "number" ? p.limit : 0,
      actual: typeof p.actual === "number" ? p.actual : 0,
      ratio: typeof p.ratio === "number" ? p.ratio : 0,
    });
  }
  return warns;
}

function renderStatus(d: RunDetail, events: StoredEvent[]): void {
  const statusColor = d.status === "success" ? chalk.green : d.status === "fail" ? chalk.red : chalk.yellow;
  console.log(chalk.bold(d.runId));
  console.log(`  title:    ${titleOf(d)}`);
  console.log(`  status:   ${statusColor(d.runStatus)} ${chalk.dim(`(${d.status})`)}`);
  console.log(`  workflow: ${d.workflowName ?? d.workflow?.slice(0, 12) ?? chalk.dim("?")}`);
  if (d.cwd != null) console.log(`  cwd:      ${d.cwd}`);
  console.log(`  cost:     $${d.costUsd.toFixed(4)} ${chalk.dim(`(${d.inputTokens}+${d.outputTokens} tok)`)}`);
  if (d.durationMs != null) console.log(`  duration: ${(d.durationMs / 1000).toFixed(1)}s`);

  // Surface any active soft budget warnings (80% mark).
  for (const w of collectActiveBudgetWarns(events)) {
    const pct = Math.round(w.ratio * 100);
    console.log(
      chalk.yellow(`  warn: ${pct}% of ${w.scope}:${w.metric} budget (actual ${w.actual}, limit ${w.limit})`),
    );
  }

  // Crash requeues: the startup sweep requeued this run after a daemon died
  // mid-dispatch — the "why did this run restart" line.
  for (const e of events) {
    if (e.type !== "fact.run_requeued_after_crash") continue;
    const p = e.payload as { prevNode?: unknown } | null;
    const prevNode = typeof p?.prevNode === "string" ? chalk.dim(` (was at node ${p.prevNode})`) : "";
    console.log(chalk.yellow(`  requeued after daemon crash at ${new Date(e.ts).toISOString()}`) + prevNode);
  }

  // The "why" for a blocked/terminal run — the last relevant fact.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "fact.run_paused") {
      const { reason, ...rest } = e.payload as { reason?: string };
      console.log(`  paused:   ${chalk.yellow(reason ?? "?")} ${chalk.dim(JSON.stringify(rest))}`);
      break;
    }
    if (e.type === "fact.run_halted") {
      const p = e.payload as { reason?: string; detail?: string };
      console.log(`  halted:   ${chalk.red(p.reason ?? "?")}${p.detail != null ? chalk.dim(` — ${p.detail}`) : ""}`);
      break;
    }
    if (e.type === "fact.run_quarantined") {
      const p = e.payload as { reason?: string; orphanedIntents?: number[] };
      console.log(
        `  quarantined: ${chalk.red(p.reason ?? "?")} ${chalk.dim(`orphans: ${(p.orphanedIntents ?? []).join(", ")}`)}`,
      );
      break;
    }
  }

  // Structured halt diagnostics from the read plane (e.g. occ_exhausted) — the
  // operator shouldn't have to hand-parse the raw event for the why.
  if (d.haltContext != null) {
    const c = d.haltContext;
    const parts: string[] = [];
    if (c.nodeId != null) parts.push(`node ${c.nodeId}`);
    if (c.iteration != null) parts.push(`iter ${c.iteration}`);
    if (c.count != null && c.attemptedFactType != null) parts.push(`${c.count} conflicts on ${c.attemptedFactType}`);
    else if (c.count != null) parts.push(`${c.count} conflicts`);
    else if (c.attemptedFactType != null) parts.push(`on ${c.attemptedFactType}`);
    if (c.lastVersion != null) parts.push(`v${c.lastVersion}`);
    if (parts.length > 0) console.log(`  context:  ${chalk.dim(parts.join(" · "))}`);
  }

  if (d.runStatus === "paused_human" && d.hitlLabel != null) {
    console.log(`  awaiting: ${chalk.yellow(d.hitlLabel)}`);
    console.log(`  routes:   ${(d.hitlOptions ?? []).join("  |  ")} ${chalk.dim("→ fragua runs respond")}`);
  }
}

export interface TailOptions extends DiscoveryOpts {
  runId: string;
  full?: boolean;
}

const TAIL_BACKFILL_LIMIT = 200;

/** Tail an existing run's event log to terminal — the same live follow +
 * inline HITL picker `fragua run` uses, for a run you didn't just enqueue.
 * Backfill is bounded to the last 200 events by default (`--full` replays
 * the entire log); the follow loop then renders the window and goes live. */
export function tailCommand(opts: TailOptions): Promise<number> {
  return withStoreClient(opts, (client) => {
    if (client.store.getState(opts.runId) == null) {
      console.error(chalk.red("tail: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    let startCursor = 0;
    if (opts.full !== true) {
      const back = client.readPlane.eventsTail(opts.runId, { limit: TAIL_BACKFILL_LIMIT }) ?? [];
      if (back.length === TAIL_BACKFILL_LIMIT) {
        console.error(chalk.dim(`(showing last ${TAIL_BACKFILL_LIMIT} events — --full for the entire log)`));
      }
      const first = back[0];
      if (first != null) startCursor = first.seq - 1;
    }
    return followRun(client, opts.runId, pickRoute, startCursor);
  });
}

export interface ExplainOptions extends DiscoveryOpts {
  runId: string;
  json?: boolean;
}

/** Synthesise a human-readable narrative of what a run did. `--json` emits the
 * full `RunExplanation` structure; the default is a narrative render. */
export function explainCommand(opts: ExplainOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const explanation = readPlane.explain(opts.runId);
    if (explanation == null) {
      console.error(chalk.red("explain: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (opts.json === true) {
      console.log(JSON.stringify(explanation, null, 2));
      return 0;
    }
    renderExplanation(explanation);
    return 0;
  });
}

function renderExplanation(e: RunExplanation): void {
  const outcomeColor =
    e.outcome.kind === "completed"
      ? chalk.green
      : e.outcome.kind === "halted" || e.outcome.kind === "quarantined"
        ? chalk.red
        : chalk.yellow;

  console.log(chalk.bold(e.runId));

  // ── Outcome ─────────────────────────────────────────────────────────────
  const outcomeLabel =
    e.outcome.kind === "completed"
      ? "completed"
      : e.outcome.kind === "halted"
        ? `halted (${e.outcome.reason}${
            "detail" in e.outcome && e.outcome.detail != null ? ` — ${e.outcome.detail}` : ""
          })`
        : e.outcome.kind === "cancelled"
          ? `cancelled${"reason" in e.outcome && e.outcome.reason != null ? ` — ${e.outcome.reason}` : ""}`
          : e.outcome.kind === "paused"
            ? `paused (${e.outcome.reason})`
            : e.outcome.kind === "paused_human"
              ? `awaiting human${"label" in e.outcome && e.outcome.label != null ? `: ${e.outcome.label}` : ""}`
              : e.outcome.kind === "quarantined"
                ? `quarantined (${e.outcome.reason})`
                : "running";
  console.log(`  outcome:  ${outcomeColor(outcomeLabel)}`);

  // ── Budget warnings ──────────────────────────────────────────────────────
  for (const w of e.budgetWarnings) {
    const pct = Math.round(w.ratio * 100);
    console.log(
      chalk.yellow(`  ⚠ warn:   ${pct}% of ${w.scope}:${w.metric} budget (actual ${w.actual}, limit ${w.limit})`),
    );
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  const cacheTokens = e.totals.cacheReadTokens + e.totals.cacheWriteTokens;
  const tokenParts = `${e.totals.inputTokens}+${e.totals.outputTokens}${
    cacheTokens > 0 ? `+${cacheTokens} cached` : ""
  }`;
  console.log(
    `  cost:     $${e.totals.costUsd.toFixed(4)} ${chalk.dim(`(${tokenParts} = ${e.totals.billedTokens} tok)`)}`,
  );
  if (e.totals.durationMs != null) {
    console.log(`  duration: ${(e.totals.durationMs / 1000).toFixed(1)}s`);
  }

  // ── Path ────────────────────────────────────────────────────────────────
  if (e.path.length > 0) {
    // `~p<n>` marks a goal-gate re-entry pass — iteration resets per pass, so
    // without it a retargeted traversal prints as an identical duplicate.
    const pathStr = e.path
      .map((p) => `${p.from}→${p.to}${p.iteration > 0 ? `#${p.iteration}` : ""}${p.pass > 0 ? `~p${p.pass}` : ""}`)
      .join("  ");
    console.log(`  path:     ${chalk.dim(pathStr)}`);
  }

  // ── Steps ────────────────────────────────────────────────────────────────
  // Mirror the Cost tab: `type: parallel` branch steps (tagged with a
  // parentNodeId by the steps projection) nest under a parent header carrying
  // the group's aggregate spend, indented beneath, instead of scattering as
  // flat sibling rows.
  if (e.steps.length > 0) {
    console.log(`  steps:    ${e.steps.length}`);
    const renderStep = (s: RunExplanation["steps"][number], indent: string): void => {
      const outcomeGlyph =
        s.outcome === "success" ? chalk.green("✓") : s.outcome === "fail" ? chalk.red("✗") : chalk.dim("?");
      const model = s.model ? chalk.dim(` ${s.model}`) : "";
      const passTag = s.pass !== undefined && s.pass > 0 ? chalk.dim(`~p${s.pass}`) : "";
      console.log(
        `${indent}${chalk.dim(`#${s.stepIdx}`)} ${outcomeGlyph} ${chalk.cyan(s.nodeId)}${passTag}${model}` +
          `  $${s.costUsd.toFixed(4)}` +
          (s.durationMs != null ? `  ${(s.durationMs / 1000).toFixed(1)}s` : ""),
      );
    };
    // Order grouped rows by DECLARED branch order (the served topology), like
    // the web's grouping — settle order is non-deterministic under the pool.
    // Stable sort keeps a branch's own scan→verify rows in execution order.
    const branchRank = (nodeId: string): number => {
      const entry = e.fanout?.branchOf[nodeId];
      const rank = entry !== undefined ? e.fanout?.orderOf[entry] : undefined;
      return rank ?? Number.MAX_SAFE_INTEGER;
    };
    let i = 0;
    while (i < e.steps.length) {
      const parent = e.steps[i]!.parentNodeId;
      if (parent === undefined) {
        renderStep(e.steps[i]!, "    ");
        i += 1;
        continue;
      }
      // Collapse the consecutive run of branch steps sharing this parent into one
      // group — a budget re-drive or a goal-gate re-entry scatters a branch's
      // rows, but each contiguous run is one fan-out pass.
      const group: RunExplanation["steps"][number][] = [];
      while (i < e.steps.length && e.steps[i]!.parentNodeId === parent) {
        group.push(e.steps[i]!);
        i += 1;
      }
      group.sort((a, b) => branchRank(a.nodeId) - branchRank(b.nodeId));
      const groupCost = group.reduce((sum, s) => sum + s.costUsd, 0);
      console.log(
        `    ${chalk.magenta("⑂")} ${chalk.cyan(parent)} ${chalk.dim("(parallel)")}  $${groupCost.toFixed(4)}`,
      );
      for (const s of group) renderStep(s, "      ");
    }
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────
  if (e.snapshots.length > 0) {
    console.log(`  snapshots: ${e.snapshots.length}`);
    for (const s of e.snapshots) {
      const stat = s.committed ?? s.uncommitted;
      const statStr =
        stat != null
          ? ` ${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"} ${chalk.green(`+${stat.insertions}`)}${chalk.dim("/")}${chalk.red(`-${stat.deletions}`)}`
          : "";
      console.log(`    ${chalk.dim(`[${s.label}]`)} ${s.nodeId ?? "(run)"}${statStr}`);
    }
  }

  // ── Diff summary ──────────────────────────────────────────────────────────
  if (e.diffSummary != null) {
    console.log(
      `  diff:     ${e.diffSummary.filesChanged} file${e.diffSummary.filesChanged === 1 ? "" : "s"} ` +
        `${chalk.green(`+${e.diffSummary.insertions}`)} ${chalk.red(`-${e.diffSummary.deletions}`)}`,
    );
  }
}

export interface WorktreeOptions extends DiscoveryOpts {
  runId: string;
}

/** Print the absolute worktree path for a run. Exit non-zero when the
 * worktree no longer exists (cleaned up by GC after the terminal snapshot). */
export function worktreeCommand(opts: WorktreeOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const detail = readPlane.runDetail(opts.runId);
    if (detail == null) {
      console.error(chalk.red("worktree: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (detail.cwd == null) {
      console.error(chalk.red("worktree: run has no worktree (bare-cwd or ephemeral)") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const wt = join(detail.cwd, ".fragua", "worktrees", opts.runId);
    if (!existsSync(wt)) {
      console.error(
        chalk.yellow(`worktree: worktree no longer exists — likely cleaned up by GC`) + chalk.dim(` (${wt})`),
      );
      return 1;
    }
    console.log(wt);
    return 0;
  });
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
    if (routes.length === 0) {
      // Fail-open is intentional (older event shapes carry no route enum),
      // but the skip must be observable so an off-list route accepted here
      // can be traced back when the daemon later halts the run on resume.
      console.warn(
        chalk.yellow(
          `respond: human input accepted without route validation — no declared routes on the latest fact.run_paused_human (run=${opts.runId} route="${route}")`,
        ),
      );
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
  resume?: boolean;
}

/** Raise a cap on a `paused{reason:"budget"}` run. Pass `--resume` to continue
 *  in one step; otherwise `resume` separately. */
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
  return writeIntent(opts, opts.runId, "budget", (p) => p.buildBudget(body), opts.resume === true);
}

export interface MaxRetriesOptions extends DiscoveryOpts {
  runId: string;
  nodeId?: string;
  newLimit: number;
  note?: string;
  resume?: boolean;
}

/** Raise one node's handler-retry cap on a `paused{reason:"max_retries"}` run.
 *  Pass `--resume` to continue in one step; otherwise `resume` separately. */
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
  return writeIntent(opts, opts.runId, "max-retries", (p) => p.buildMaxRetries(body), opts.resume === true);
}

export interface GoalGateOptions extends DiscoveryOpts {
  runId: string;
  newLimit: number;
  note?: string;
  resume?: boolean;
}

/** Raise the goal-gate retry cap on a `paused{reason:"goal_gate"}` run. Pass
 *  `--resume` to continue in one step; otherwise `resume` separately. */
export function goalGateCommand(opts: GoalGateOptions): Promise<number> {
  if (!Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("goal-gate: <newLimit> integer required"));
    return Promise.resolve(1);
  }
  const body: { newLimit: number; note?: string } = { newLimit: opts.newLimit };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "goal-gate", (p) => p.buildGoalGate(body), opts.resume === true);
}

export interface MaxLoopsOptions extends DiscoveryOpts {
  runId: string;
  newLimit: number;
  note?: string;
  resume?: boolean;
}

/** Raise the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run.
 *  Pass `--resume` to continue in one step; otherwise `resume` separately. */
export function maxLoopsCommand(opts: MaxLoopsOptions): Promise<number> {
  if (!Number.isFinite(opts.newLimit)) {
    console.error(chalk.red("max-loops: <newLimit> integer required"));
    return Promise.resolve(1);
  }
  const body: { newLimit: number; note?: string } = { newLimit: opts.newLimit };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return writeIntent(opts, opts.runId, "max-loops", (p) => p.buildMaxLoops(body), opts.resume === true);
}

export interface LsOptions extends DiscoveryOpts {
  status?: string;
  limit?: number;
  json?: boolean;
  summary?: boolean;
}

/** List runs (optionally filtered by lifecycle status). With `--summary`,
 *  print a fleet rollup instead of the per-run list. */
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
    if (opts.summary === true) {
      const summary = readPlane.fleetSummary({
        cwd,
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(statuses !== undefined ? { statuses } : {}),
      });
      if (opts.json === true) {
        console.log(JSON.stringify(summary, null, 2));
        return 0;
      }
      renderFleetSummary(summary);
      return 0;
    }
    const rows = readPlane.runSummaries({
      cwd,
      order: "newest",
      limit: opts.limit ?? 30,
      ...(statuses !== undefined ? { statuses } : {}),
    });
    if (opts.json === true) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
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

/** Render the `--summary` fleet rollup: a status-count line, a per-workflow
 *  table, and the total in-flight (non-terminal) cost. */
function renderFleetSummary(s: FleetSummary): void {
  if (s.totalRuns === 0) {
    console.log(chalk.dim("ls --summary: no runs"));
    return;
  }

  const statusLine = RUN_STATUSES.filter((st) => s.statusCounts[st] > 0)
    .map((st) => `${st}:${chalk.cyan(s.statusCounts[st])}`)
    .join("  ");
  console.log(`${chalk.dim("status")}  ${statusLine}  ${chalk.dim(`(${s.totalRuns} total)`)}`);

  if (s.workflows.length > 0) {
    const nameW = Math.max(8, ...s.workflows.map((w) => w.workflow.length));
    console.log(
      chalk.dim(
        `${"workflow".padEnd(nameW)}  ${"running".padStart(7)}  ${"done".padStart(4)}  ${"failed".padStart(6)}`,
      ),
    );
    for (const w of s.workflows) {
      console.log(
        `${w.workflow.padEnd(nameW)}  ${String(w.running).padStart(7)}  ${String(w.done).padStart(4)}  ${String(
          w.failed,
        ).padStart(6)}`,
      );
    }
  }

  console.log(`${chalk.dim("in-flight cost")}  $${s.inFlightCostUsd.toFixed(4)}`);
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

// ─── Forensics (read-only): the operate skill's dissection verbs ────────────

export interface EventsOptions extends DiscoveryOpts {
  runId: string;
  type?: string;
  limit?: number;
  since?: number;
  json?: boolean;
}

/** Dump a run's event log. `--type <prefix>` filters by type prefix,
 * `--limit N` keeps the last N (default 50), `--since <seq>` keeps events
 * with seq strictly greater (unbounded unless `--limit` is also given),
 * printed oldest-first. The bound is a SQL-level read — long runs never
 * hydrate the full log. `--json` emits the raw `StoredEvent[]` with full
 * payloads (the operate skill's forensics reference mines these); the
 * default render reuses the live-follow `[seq] type payload` line. */
export function eventsCommand(opts: EventsOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const limit = opts.limit != null && opts.limit > 0 ? opts.limit : opts.since != null ? undefined : 50;
    const tail = readPlane.eventsTail(opts.runId, {
      ...(opts.since != null ? { sinceSeq: opts.since } : {}),
      ...(opts.type != null && opts.type.length > 0 ? { typePrefix: opts.type } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (tail == null) {
      console.error(chalk.red("events: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (opts.json === true) {
      console.log(JSON.stringify(tail, null, 2));
      return 0;
    }
    for (const ev of tail) renderEvent(ev);
    return 0;
  });
}

export interface StepsOptions extends DiscoveryOpts {
  runId: string;
  json?: boolean;
}

/** Per-LLM-call cost / token / duration breakdown. `--json` emits the full
 * `StepSnapshot[]` (resolved prompts etc.); default is one line per step. */
export function stepsCommand(opts: StepsOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const steps = readPlane.steps(opts.runId);
    if (steps == null) {
      console.error(chalk.red("steps: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (opts.json === true) {
      console.log(JSON.stringify(steps, null, 2));
      return 0;
    }
    if (steps.length === 0) {
      console.log(chalk.dim("(no LLM steps)"));
      return 0;
    }
    for (const s of steps) console.log(renderStepLine(s));
    return 0;
  });
}

function renderStepLine(s: StepSnapshot): string {
  const tokens =
    s.cost?.billed_tokens ??
    (s.cost?.input_tokens ?? 0) +
      (s.cost?.output_tokens ?? 0) +
      (s.cost?.cache_read_tokens ?? 0) +
      (s.cost?.cache_write_tokens ?? 0);
  const cost = (s.cost?.cost_usd ?? 0).toFixed(4);
  const dur = s.durationMs != null ? `${s.durationMs}` : "?";
  return (
    `${chalk.dim(`#${s.stepIdx}`)}  ${chalk.cyan(s.nodeId)}  ${s.model ?? chalk.dim("?")}  ` +
    `${tokens} tok  $${cost}  ${dur} ms`
  );
}

export interface MessagesOptions extends DiscoveryOpts {
  runId: string;
  node?: string;
  json?: boolean;
}

/** LLM-visible transcript. `--node <id>` scopes to one node. `--json` emits the
 * full messages (transcript mining); default is one preview line per message. */
export function messagesCommand(opts: MessagesOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const msgs = readPlane.messages(opts.runId, opts.node != null ? { nodeId: opts.node } : {});
    if (msgs == null) {
      console.error(chalk.red("messages: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (opts.json === true) {
      console.log(JSON.stringify(msgs, null, 2));
      return 0;
    }
    for (const m of msgs) console.log(renderMessageLine(m));
    return 0;
  });
}

/** A pi-agent-core message's `content` is either a plain string or an array of
 * typed blocks; only the text blocks carry prose. */
interface TextBlock {
  type: string;
  text?: string;
}

function previewOf(content: NarrowMessage["content"]): string {
  const raw = content as { role?: string; content?: unknown };
  const body = raw.content;
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else if (Array.isArray(body)) {
    text = (body as TextBlock[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join(" ");
  } else {
    text = "";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

function renderMessageLine(m: NarrowMessage): string {
  const role = (m.content as { role?: string }).role ?? "?";
  const where = `${m.nodeId ?? "?"}#${m.iteration}`;
  return `${chalk.dim(`[${m.ordinal}]`)} ${chalk.cyan(role)} ${chalk.dim(where)}  ${previewOf(m.content)}`;
}

export interface ArtifactsOptions extends DiscoveryOpts {
  runId: string;
}

/** List a run's artifacts: one line per artifact, metadata only. */
export function artifactsCommand(opts: ArtifactsOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const rows = readPlane.artifacts(opts.runId);
    if (rows == null) {
      console.error(chalk.red("artifacts: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    if (rows.length === 0) {
      console.log(chalk.dim("(no artifacts)"));
      return 0;
    }
    for (const a of rows) {
      console.log(
        `${chalk.cyan(`${a.nodeId}#${a.iteration}`)}  ${a.key}  ${chalk.dim(a.mime ?? "?")}  ${a.sizeBytes}B`,
      );
    }
    return 0;
  });
}

export interface ArtifactOptions extends DiscoveryOpts {
  runId: string;
  nodeId: string;
  key: string;
  iteration?: number;
}

/** Write one artifact's bytes to stdout. Text passes through as-is; binary
 * (NUL byte in the first 8KiB) is refused with a notice on stderr so the
 * terminal isn't garbled — redirect to a file instead. */
export function artifactCommand(opts: ArtifactOptions): Promise<number> {
  return withStoreClient(opts, ({ readPlane }) => {
    const scope: ArtifactScope = {
      runId: opts.runId,
      nodeId: opts.nodeId,
      key: opts.key,
      iteration: opts.iteration ?? 0,
    };
    const bytes = readPlane.artifactBody(scope);
    if (bytes == null) {
      console.error(
        chalk.red("artifact: not found") + chalk.dim(` (${opts.runId}/${opts.nodeId}#${scope.iteration}:${opts.key})`),
      );
      return 1;
    }
    if (looksBinary(bytes)) {
      console.error(chalk.yellow(`(binary, ${bytes.byteLength} bytes — redirect to a file)`));
      return 1;
    }
    process.stdout.write(bytes);
    return 0;
  });
}

/** A NUL byte in the first 8KiB is the same heuristic git uses to flag a blob
 * as binary. */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

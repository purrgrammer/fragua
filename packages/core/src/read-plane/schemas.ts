// TypeBox view schemas for the run-read surface — the shapes every read
// client (HTTP server, CLI store-client) hands back for `/runs` summary and
// detail reads. Re-exported by `@fragua/server`'s schemas so existing
// `import { RunSummary } from "../schemas.ts"` consumers keep working.

import { type Static, Type } from "@sinclair/typebox";

/** Coarse UI status — one badge per category. The Inbox / fine-grained
 * filters use `runStatus` (the raw store status) instead. */
const UiStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("success"),
  Type.Literal("fail"),
  Type.Literal("canceled"),
  Type.Literal("unknown"),
]);

/** Raw run lifecycle status, mirrored from `@fragua/types` `RunStatus`.
 * Carried alongside the coarse `status` so the web can distinguish
 * `paused_human` vs `paused` (Inbox) and `halted` vs `quarantined`
 * (Inbox vs Feed) without re-reading the event log. */
const RawRunStatus = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("paused_human"),
  Type.Literal("paused_auto"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("halted"),
  Type.Literal("quarantined"),
]);

/** Per-side diff stat — mirrors `@fragua/types` SnapshotStat. */
const SnapshotStat = Type.Object({
  filesChanged: Type.Integer({ minimum: 0 }),
  insertions: Type.Integer({ minimum: 0 }),
  deletions: Type.Integer({ minimum: 0 }),
});

/** Terminal diff projection (`run_state.change_stat`): workflow-authored
 * commits vs. agent dirt; either side null when absent. */
const ChangeStat = Type.Object({
  committed: Type.Union([SnapshotStat, Type.Null()]),
  uncommitted: Type.Union([SnapshotStat, Type.Null()]),
});

/** Summary row returned by `GET /runs`. */
export const RunSummary = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: UiStatus,
  runStatus: RawRunStatus,
  eventCount: Type.Integer({ minimum: 0 }),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  /** Per-machine LOCATION — the resolved project root. Mirrors
   * `run_state.cwd`. Absent for ephemeral runs (CI primitives, tests). */
  cwd: Type.Optional(Type.String()),
  /** Project IDENTITY + display label — how a run attributes to a project,
   * portable across clones / imports. Always present on real runs. */
  projectId: Type.Optional(Type.String()),
  projectName: Type.Optional(Type.String()),
  /** Worktree inbox status. Present only on terminal worktree runs;
   * `pending` = awaiting an operator primitive. */
  inboxStatus: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("acted"), Type.Literal("discarded")])),
  /** Terminal diff stat — drives the inbox row's `+X / −Y, N files` badge. */
  changeStat: Type.Optional(ChangeStat),
  /** Source repo branch at provision — the operator-action target default
   * and the git-centric row label. Absent when provisioned detached. */
  baseGitRef: Type.Optional(Type.String()),
  /** Source repo HEAD sha at provision (for a short-sha label). */
  baseGitSha: Type.Optional(Type.String()),
  /** True when the run was brought in via `fragua import`. The run is
   * inspect-only: the daemon will never dispatch it, and operate controls
   * (pause/resume/cancel) must be suppressed. Derived from the
   * `imported_runs` inert marker — not from `cwd == null`. */
  imported: Type.Optional(Type.Boolean()),
});
export type RunSummary = Static<typeof RunSummary>;

export const NodeState = Type.Object({
  nodeId: Type.String(),
  /** Loop iteration this entry describes (0 for the first dispatch, 1 for
   * the first re-entry across a backward edge or goal-gate retarget, …). A
   * non-looping run carries only `iteration: 0` entries. */
  iteration: Type.Integer({ minimum: 0 }),
  state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
    Type.Literal("retrying"),
  ]),
  lastEventSeq: Type.Integer({ minimum: 0 }),
});
export type NodeState = Static<typeof NodeState>;

/** `(from, to)` pair for an edge the executor actually traversed. Projected
 * from the run's `edge.selected` event stream. Lets the UI fade edges that
 * were never taken so the executed path pops visually. Multiple entries for
 * the same `(from, to)` are emitted when a back-edge or goal-gate retarget
 * re-traverses across iterations; `iteration` distinguishes them. */
export const SelectedEdge = Type.Object({
  from: Type.String(),
  to: Type.String(),
  iteration: Type.Integer({ minimum: 0 }),
});
export type SelectedEdge = Static<typeof SelectedEdge>;

export const RunDetail = Type.Object({
  runId: Type.String(),
  workflow: Type.Optional(Type.String()),
  workflowName: Type.Optional(Type.String()),
  startedAt: Type.String(),
  status: UiStatus,
  runStatus: RawRunStatus,
  lastEventSeq: Type.Integer({ minimum: 0 }),
  nodes: Type.Array(NodeState),
  selectedEdges: Type.Array(SelectedEdge),
  workflowSource: Type.Optional(Type.String()),
  costUsd: Type.Number({ minimum: 0, default: 0 }),
  inputTokens: Type.Integer({ minimum: 0, default: 0 }),
  outputTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheReadTokens: Type.Integer({ minimum: 0, default: 0 }),
  cacheWriteTokens: Type.Integer({ minimum: 0, default: 0 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  title: Type.Optional(Type.String()),
  hitlNodeId: Type.Optional(Type.String()),
  /** Operator-facing question text from the paused human node's `text=`
   *  attr (when `runStatus === 'paused_human'`). */
  hitlLabel: Type.Optional(Type.String()),
  /** Declared route names from the paused human node's `routes=` attr;
   *  one button rendered per route. */
  hitlOptions: Type.Optional(Type.Array(Type.String())),
  /** Sparse route-name → button-text map from each outgoing edge's `label=`
   *  override (D6). Routes absent here fall back to `humanizeRouteName`. */
  hitlOptionLabels: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Per-node record of the route (and optional note) the operator chose at
   *  each answered human gate, derived from `intent.human_input`. Survives
   *  resume so a running/terminal run still shows past decisions. */
  hitlDecisions: Type.Optional(
    Type.Record(Type.String(), Type.Object({ route: Type.String(), note: Type.Optional(Type.String()) })),
  ),
  /** Per-machine LOCATION — the resolved project root. Mirrors
   * `run_state.cwd`. Absent for ephemeral runs (CI primitives, tests). */
  cwd: Type.Optional(Type.String()),
  /** Project IDENTITY + display label (for the run-detail breadcrumb /
   * project link). Always present on real runs. */
  projectId: Type.Optional(Type.String()),
  projectName: Type.Optional(Type.String()),
  /** Absolute path to the still-mounted worktree under
   * `<cwd>/.fragua/worktrees/<runId>`. Absent once the worktree has
   * been disposed (run terminal + provisioner cleanup) or for runs
   * whose cwd wasn't a git repo (per-run LocalEnvironment fallback). */
  worktreePath: Type.Optional(Type.String()),
  /** Source repo branch + HEAD sha at provision — shown in run-detail
   * git metadata and the operator-action target default. */
  baseGitRef: Type.Optional(Type.String()),
  baseGitSha: Type.Optional(Type.String()),
  /** True when the run was brought in via `fragua import`. The run has no
   * local `cwd`, the daemon will never dispatch it, and operate controls
   * (pause/resume/cancel) should be suppressed. Derived from `cwd == null`
   * combined with the `imported_runs` marker semantics. */
  imported: Type.Optional(Type.Boolean()),
});
export type RunDetail = Static<typeof RunDetail>;

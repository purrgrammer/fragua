// Ports for @swarm/server. Route handlers depend on these interfaces; adapters
// (filesystem, in-memory interviewer) live in ./adapters/ and plug in via
// `createServer`. Tests swap in fakes to keep assertions fast and free of
// I/O. This mirrors the pattern used by @swarm/core.

import type { Event, EventSink } from "@swarm/core";
import type { EventSource } from "@swarm/events";

/**
 * Reader for the run archive. The server never touches `node:fs` directly —
 * all on-disk shape concerns live in the adapter.
 *
 * NOTE: this is interface-equivalent to `EventSource` in `@swarm/events`
 * (listRuns + readRun/readEvents) — they exist side-by-side because the
 * server defined `RunReader` before the read-side port was hoisted into
 * @swarm/events. New code should prefer `EventSource`; `RunReader` lives
 * on to keep existing adapters compiling. A thin `runReaderFromSource`
 * adapter below bridges between the two method names until the next
 * refactor pass unifies them.
 */
export interface RunReader {
  /** Enumerate all run ids (usually directory names under `.swarm/runs/`). */
  listRuns(): Promise<string[]>;
  /**
   * Load every event for a run in the order they were written. Returns
   * `undefined` when the run does not exist so handlers can respond with 404
   * rather than distinguishing "missing" from "empty".
   */
  readEvents(runId: string): Promise<Event[] | undefined>;
}

/** Bridge: wrap an `EventSource` as a `RunReader`. Route handlers keep
 * the `RunReader` type; new sinks/adapters can be written against the
 * canonical `EventSource` port in @swarm/events and plugged in via
 * this adapter. */
export function runReaderFromSource(source: EventSource): RunReader {
  return {
    listRuns: () => source.listRuns(),
    readEvents: (runId) => source.readRun(runId),
  };
}

/** Inverse bridge — wrap a `RunReader` as an `EventSource`. Route code
 * that wants `projectRun` / `foldAll` on an existing `opts.runReader`
 * calls this once at the top of the handler. */
export function sourceFromRunReader(reader: RunReader): EventSource {
  return {
    listRuns: () => reader.listRuns(),
    readRun: (runId) => reader.readEvents(runId),
  };
}

/** A pending question tagged with its originating run for routing. */
export interface PendingQuestion {
  runId: string;
  questionId: string;
  nodeId: string;
  text: string;
  type: "YES_NO" | "MULTIPLE_CHOICE" | "FREEFORM" | "CONFIRMATION";
  options?: Array<{ key: string; label: string }>;
  stage: string;
  askedAt: string;
}

export type InterviewAnswerResult =
  | { ok: true }
  | { ok: false; code: "unknown_question" | "already_answered" | "invalid_answer"; message: string };

/**
 * Gateway for the web interview channel. Decouples the REST surface from the
 * concrete `Interviewer` implementation (see task 03). In P5.02 the default
 * adapter derives pending questions from the event stream and delegates
 * answer dispatch to an injected `EventSink`.
 */
export interface InterviewGateway {
  /** Pending (unanswered) questions for a run, in ask order. */
  pending(runId: string): Promise<PendingQuestion[]>;
  /** Submit an answer. Emits `interview.completed` on the EventSink when ok. */
  answer(runId: string, questionId: string, answer: { value: string; text?: string }): Promise<InterviewAnswerResult>;
}

/**
 * One workflow source (usually a `.dot` file on disk) surfaced by
 * `GET /workflows`. The server is authoritative for this shape; the web
 * package re-declares a mirror in `lib/api.ts` so we don't leak a
 * cross-package type dependency into the client bundle.
 *
 * Fields:
 *   - `name`  — the filename without extension (`build-feature`). Used
 *     as the primary label in list UIs.
 *   - `path`  — the path the server read from, relative to the runtime
 *     working directory. Displayed in small/monospace context so
 *     operators can `cat` the source.
 *   - `sha`   — first 7 hex chars of sha256 over the file contents. A
 *     short hash is enough for "is this the workflow I expect?" at a
 *     glance without bloating the row.
 *   - `label` — optional best-effort extraction of a `label="…"` attr
 *     from the DOT source. When absent the UI falls back to `name`.
 */
export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
}

/** Enumerate workflow definitions available on disk for `GET /workflows`. */
export interface WorkflowReader {
  list(): Promise<WorkflowSummary[]>;
}

/** Result of submitting a control request. The id is the uuid the gateway
 * assigned (clients don't supply one — the gateway owns idempotency
 * keys so callers can't collide). `not_found` means the run doesn't
 * exist in the runs archive; route handlers translate to 404. */
export type ControlSubmitResult = { ok: true; id: string } | { ok: false; code: "not_found" };

/** Control channel gateway. REST routes for `/pipelines/:runId/steer`,
 * `/pipelines/:runId/pause`, `/pipelines/:runId/resume`, and
 * `/pipelines/:runId/cancel` all funnel through this one port. The
 * default adapter (`createFsControlGateway`) writes a `ControlRequest`
 * line to `<runsDir>/<runId>/control.jsonl` so the executor's control
 * loop picks it up. A future daemon-backed gateway will route through
 * HTTP instead of a shared filesystem — the REST surface doesn't
 * care. */
export interface ControlGateway {
  /** Submit a steer request. `message` is the user text to inject at
   * the active agent's next turn boundary. */
  steer(runId: string, message: string): Promise<ControlSubmitResult>;
  /** Request a soft pause. The run finishes its current node then gates. */
  pause(runId: string, reason?: string): Promise<ControlSubmitResult>;
  /** Wake a paused run. No-ops (rejected at the executor) if not paused. */
  resume(runId: string): Promise<ControlSubmitResult>;
  /** Graceful cancel. Emits `pipeline.canceled` as the terminal event. */
  cancel(runId: string, reason?: string): Promise<ControlSubmitResult>;
}

/**
 * One skill surfaced by `GET /skills`. Metadata only — the heavy SKILL.md
 * body is fetched via `GET /skills/:name` and read on demand. Mirrors the
 * `Skill` shape in @swarm/workspace but re-declared server-side so the
 * web package has a stable wire contract without importing workspace.
 */
export interface SkillSummary {
  name: string;
  description: string;
  version?: string;
  allowed_tools?: string[];
  location: string;
  skill_dir: string;
  sha256: string;
  bytes: number;
  scope: "project" | "user";
  source_dir: string;
  /** When set, the skill was discovered but excluded from the tier-1
   * catalog the agent sees. The UI shows it greyed out with this tooltip. */
  disabled_reason?: string;
}

/** Full skill detail for `GET /skills/:name` — summary + SKILL.md body. */
export interface SkillDetail extends SkillSummary {
  /** SKILL.md body with YAML frontmatter stripped. */
  body: string;
}

/** Port for discovering + reading skills. Implementations live in
 * ./adapters/ — the default scans the local filesystem via
 * `@swarm/workspace` `discoverSkills`. Tests inject fakes. */
export interface SkillReader {
  list(opts?: { refresh?: boolean }): Promise<SkillSummary[]>;
  /** Returns `undefined` when the skill is not found so the route can 404. */
  read(name: string): Promise<SkillDetail | undefined>;
}

/**
 * Durable queue of workflow runs waiting to be dispatched + in-flight
 * runs claimed by the daemon's scheduler. The default adapter is
 * SQLite-backed (`createSqliteJobQueue`); hosted deployments will
 * swap to a network DB later.
 *
 * Lifecycle of a row: `queued` → (claimNext) → `running` → (markTerminal)
 * → one of `success` | `failed` | `canceled`. Only `queued` rows can be
 * `delete`d outright; running rows go through the control channel.
 *
 * The queue owns the `run_id` column — one run id per job, unique across
 * the table, surfaced in responses so the HTTP layer can deep-link into
 * the existing `/pipelines/:runId/*` routes.
 */
export type JobStatus = "queued" | "running" | "success" | "failed" | "canceled";

export interface JobRow {
  id: string;
  runId: string;
  workflow: string;
  inputJson?: string;
  model?: string;
  status: JobStatus;
  priority: number;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  childPid?: number;
  error?: string;
  /** Run inside an isolated git worktree (branch `swarm/<runId>`)?
   * Defaults to true for new rows — `swarm run` is worktree-by-default
   * so concurrent runs don't step on each other. Clients pass `false`
   * to opt out. */
  worktree: boolean;
}

/** Fields a caller can pass to `enqueue`. The queue assigns id, run id,
 * status, enqueued_at. */
export interface EnqueueInput {
  workflow: string;
  inputJson?: string;
  model?: string;
  /** Optional client-supplied id. When omitted a uuid is generated.
   * Used to keep tests deterministic and to let clients retry safely. */
  id?: string;
  /** Optional client-supplied run id. When omitted the queue generates
   * one matching the existing `${Date.now()}-${random6}` format used
   * by `swarm run`. */
  runId?: string;
  /** Priority tie-breaker. Higher runs first; ties break on enqueuedAt
   * ascending. Default 0. */
  priority?: number;
  /** Run inside an isolated git worktree? Default true. Omit to accept
   * the default; pass `false` only for explicit opt-out via
   * `swarm run --no-worktree`. */
  worktree?: boolean;
}

export interface JobListFilter {
  status?: JobStatus;
  /** Max rows to return. Default 50. */
  limit?: number;
  /** Opaque cursor from a prior `list` call. Not yet implemented — reserved. */
  cursor?: string;
}

/**
 * Adapter over whatever primitive actually runs the workflow. The local
 * default (`createLocalProcessSupervisor`) spawns `swarm run` as a
 * child process; a future hosted adapter would talk to a container
 * runtime or remote worker.
 *
 * `spawn` is given the whole job row — it has the workflow path, run
 * id, input, and model. It returns the pid (cached by the scheduler
 * so cancel has something to signal) and an `exited` promise that
 * resolves with the child's exit code.
 *
 * `terminate` sends a signal to a pid previously returned by `spawn`.
 * Returns false if the process is already gone.
 */
export interface ProcessSupervisor {
  spawn(job: JobRow): Promise<{ pid: number; exited: Promise<number> }>;
  terminate(pid: number, signal?: "SIGTERM" | "SIGKILL"): Promise<boolean>;
}

export interface JobQueue {
  enqueue(input: EnqueueInput): Promise<JobRow>;
  get(jobId: string): Promise<JobRow | undefined>;
  list(filter?: JobListFilter): Promise<JobRow[]>;
  /** Atomically claim the next queued row, moving it to `running`.
   * Returns `undefined` when the queue is empty. */
  claimNext(): Promise<JobRow | undefined>;
  markRunning(jobId: string, childPid: number): Promise<void>;
  markTerminal(jobId: string, status: "success" | "failed" | "canceled", error?: string): Promise<void>;
  /** Remove a queued row. Throws if the row is in any other status. */
  delete(jobId: string): Promise<void>;
  /** All rows currently in `running` — used for orphan recovery on daemon startup. */
  runningJobs(): Promise<JobRow[]>;
  /** Fast count for a given status. Used by `/health` to report inflight +
   * queued without loading the rows. */
  count(status: JobStatus): Promise<number>;
  /** Release DB resources. Tests use this to avoid leaking file handles. */
  close(): Promise<void>;
}

/** Bundle of ports passed to `createServer`. All optional; defaults below. */
export interface ServerPorts {
  runReader?: RunReader;
  interviewGateway?: InterviewGateway;
  workflowReader?: WorkflowReader;
  controlGateway?: ControlGateway;
  skillReader?: SkillReader;
  jobQueue?: JobQueue;
  processSupervisor?: ProcessSupervisor;
  /** Optional sink for interview.* events emitted on answer. */
  eventSink?: EventSink;
  /** Per-request provider for daemon metadata merged into `/health` under
   * the `daemon` key. Present only when the server runs inside the
   * swarm daemon; absent for plain `swarm serve`. */
  daemonInfo?: () =>
    | import("./routes/health.ts").HealthDaemonInfo
    | Promise<import("./routes/health.ts").HealthDaemonInfo>;
}

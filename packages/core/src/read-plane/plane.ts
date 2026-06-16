// The read plane — one projection surface every read client (HTTP server,
// CLI store-client, future clients) routes through, so no two readers can
// disagree about how a run projects into the summary / detail / step /
// message views.
//
// Each method does the store read + projection, mirroring the read handlers
// that previously lived server-only (`GET /runs`, `/runs/:id`,
// `/runs/:id/events.json`, `/runs/:id/steps`, `/runs/:id/messages`). The
// store is INJECTED (only its type is imported, so this module adds no
// runtime dependency surface beyond `@fragua/store`'s types); this is the
// store-dependent sub-entry, excluded from the browser bundle just like
// `@fragua/core/intent-plane`.

import type {
  ArtifactListRow,
  ArtifactScope,
  FleetSummary,
  FleetSummaryOpts,
  GetEventsTailOpts,
  GetGlobalEventsAtFloorOpts,
  GetGlobalEventsForwardOpts,
  GetMessagesOpts,
  IEventReader,
  ListRunSummaryRowsOpts,
  NarrowMessage,
  StoredEvent,
} from "@fragua/store";
import { FEED_EVENT_KINDS, isTerminal as isTerminalStatus } from "@fragua/types";
import { deserializeGraph } from "../ir.ts";
import { buildExplanation, type RunExplanation } from "./explain.ts";
import { projectRunOutputs, runStateToDetail, runSummaryRowToSummary } from "./projections.ts";
import type { RunDetail, RunSummary } from "./schemas.ts";
import { type DiffRange, parseEventIdx, type SnapshotItem, toScrubberRow } from "./snapshots.ts";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations, type StepSnapshot } from "./steps.ts";

export type { ArtifactListRow, ArtifactScope, FleetSummary, FleetSummaryOpts, FleetWorkflowRow } from "@fragua/store";

export interface ReadPlaneDeps {
  store: IEventReader;
}

/** Forward-cursor fields for the global feed, MINUS the `kindIn`
 *  allow-list — the read plane bakes `FEED_EVENT_KINDS` in, so the
 *  caller (SSE loop, future CLI watch) never threads it. */
export type GlobalFeedForwardCursor = Omit<GetGlobalEventsForwardOpts, "kindIn">;

/** At-floor (boundary rescan) cursor fields for the global feed, MINUS
 *  the `kindIn` allow-list. See {@link GlobalFeedForwardCursor}. */
export type GlobalFeedAtFloorCursor = Omit<GetGlobalEventsAtFloorOpts, "kindIn">;

export interface ReadPlane {
  /** SQL-backed list projection — one `RunSummary` per row, no per-row
   *  event-log fetch. Mirrors `GET /runs`. */
  runSummaries(opts?: ListRunSummaryRowsOpts): RunSummary[];
  /** Fleet rollup — status counts, per-workflow breakdown, and total
   *  in-flight cost across the (optionally `--status`/`--cwd`/`--limit`
   *  scoped) set. All sums/counts come from SQL aggregation. Backs
   *  `fragua runs ls --summary`. */
  fleetSummary(opts?: FleetSummaryOpts): FleetSummary;
  /** Full detail projection for one run, or `null` when the run is absent.
   *  Mirrors `GET /runs/:id`. */
  runDetail(runId: string): RunDetail | null;
  /** Per-LLM-call cost / context breakdown, or `null` when the run is
   *  absent. Mirrors `GET /runs/:id/steps`. */
  steps(runId: string): StepSnapshot[] | null;
  /** LLM-visible message transcript (§I9), or `null` when the run is
   *  absent. Mirrors `GET /runs/:id/messages`. */
  messages(runId: string, opts?: GetMessagesOpts): NarrowMessage[] | null;
  /** Raw store event log (`fact.*` + `intent.*`), or `null` when the run
   *  is absent. Mirrors `GET /runs/:id/events.json`. */
  events(runId: string): StoredEvent[] | null;
  /** Bounded tail of the raw event log — the last `opts.limit` events
   *  strictly after `opts.sinceSeq`, optionally type-prefix filtered,
   *  oldest-first — or `null` when the run is absent. SQL-level bound;
   *  backs the CLI's `runs events` / `runs tail` reads. */
  eventsTail(runId: string, opts?: GetEventsTailOpts): StoredEvent[] | null;
  /** A run's artifact listing (metadata only), or `null` when the run is
   *  absent. The bytes come from {@link ReadPlane.artifactBody}. */
  artifacts(runId: string): ArtifactListRow[] | null;
  /** Raw bytes of one artifact, or `null` when no artifact exists at the
   *  scope. */
  artifactBody(scope: ArtifactScope): Uint8Array | null;
  /** Ordered snapshot scrubber feed, or `null` when the run is absent.
   *  Mirrors `GET /runs/:id/snapshots`. */
  snapshots(runId: string): SnapshotItem[] | null;
  /** Resolve a snapshot diff request into `(cwd, fromSha, toSha)`, or a
   *  refusal. Pure — picks the commit shas; the git diff is the caller's.
   *  Mirrors the resolution in `GET /runs/:id/snapshots/:eventIdx/diff`. */
  diffRange(runId: string, eventIdx: number, against: string): DiffRange;
  /** Per-run incremental tail: events strictly after `sinceSeq`, up to
   *  `limit`, in seq order. No kind filter — the run view needs every
   *  event. Backs `GET /runs/:id/events` and the `/runs/:id/stream`
   *  drain loop. */
  eventsSince(runId: string, sinceSeq: number, limit?: number): StoredEvent[];
  /** Synthesise a human/machine-readable narrative from the run's full event
   *  log: path taken, per-step outcome + cost, snapshots, diff-vs-base
   *  summary, terminal status + halt/pause reason, and any unconsumed soft
   *  budget warnings. Returns `null` when the run does not exist. Pure
   *  read-plane projection — no writes. */
  explain(runId: string): RunExplanation | null;
  /** Global cross-run feed backfill: most-recent `limit` allow-listed
   *  events, oldest-first. `FEED_EVENT_KINDS` is baked in. Backs
   *  `GET /events`. */
  globalFeedLatest(limit: number): StoredEvent[];
  /** Global feed forward strict-tuple scan. `FEED_EVENT_KINDS` is baked
   *  in. Backs the `/events/stream` forward query. */
  globalFeedForward(cursor: GlobalFeedForwardCursor): StoredEvent[];
  /** Global feed boundary rescan at `floorTs`. `FEED_EVENT_KINDS` is
   *  baked in. Backs the `/events/stream` at-floor query. */
  globalFeedAtFloor(cursor: GlobalFeedAtFloorCursor): StoredEvent[];
}

export function makeReadPlane(deps: ReadPlaneDeps): ReadPlane {
  const { store } = deps;
  return {
    runSummaries(opts = {}) {
      return store.listRunSummaryRows(opts).map(runSummaryRowToSummary);
    },
    fleetSummary(opts = {}) {
      return store.fleetSummary(opts);
    },
    runDetail(runId) {
      const state = store.getState(runId);
      if (state == null) return null;
      const events = store.getEvents(runId);
      const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
      const detail = runStateToDetail(state, events, wf?.name, wf?.source);
      detail.lastEventSeq = events.at(-1)?.seq ?? 0;
      // Typed-partial egress envelope (proposal §11): project the run-level
      // `outputs:` block over the producer's latest emission. Reads the
      // executable IR (carries `graph.attrs.outputs`) and the outputs index
      // (`getLatestOutput` already rehydrates a `{$fragua_blob}` spill and
      // resolves the latest iteration). A read-plane projection — no fact, no
      // write path.
      if (wf?.ir != null) {
        let runOutputs: ReturnType<typeof deserializeGraph>["attrs"]["outputs"];
        try {
          runOutputs = deserializeGraph(wf.ir).attrs.outputs;
        } catch {
          runOutputs = undefined; // malformed IR — no envelope rather than a crash
        }
        const outputs = projectRunOutputs(runOutputs ?? [], state.status, (node) => store.getLatestOutput(runId, node));
        if (outputs !== undefined) detail.outputs = outputs;
      }
      return detail;
    },
    steps(runId) {
      const state = store.getState(runId);
      if (state == null) return null;
      // Two-pass projection:
      //   1. eventsToSteps walks the full event log to extract per-step
      //      static fields.
      //   2. getStepAggregates runs a SQL window aggregation that sums
      //      cost / token totals per step, keyed by `startSeq` — the single
      //      source of truth for numerical totals.
      const events = store.getEvents(runId);
      const steps = attachStepAggregates(eventsToSteps(events), store.getStepAggregates(runId)).map(
        (step, stepIdx) => ({ ...step, stepIdx }),
      );
      // Fill `durationMs` for orphan steps (no `llm.done` in the window).
      // Each step's effective end is the next step's `startedAt`, falling
      // back to the run's last event timestamp when the run is terminal.
      const lastEventTs = events.length > 0 ? Math.max(...events.map((event) => event.ts)) : undefined;
      return fillOrphanDurations(steps, {
        lastEventTs,
        runIsTerminal: isTerminalStatus(state.status),
      });
    },
    messages(runId, opts = {}) {
      if (store.getState(runId) == null) return null;
      return store.getMessagesNarrow(runId, opts);
    },
    events(runId) {
      if (store.getState(runId) == null) return null;
      return store.getEvents(runId);
    },
    eventsTail(runId, opts = {}) {
      if (store.getState(runId) == null) return null;
      return store.getEventsTail(runId, opts);
    },
    artifacts(runId) {
      if (store.getState(runId) == null) return null;
      return store.listArtifacts(runId);
    },
    artifactBody(scope) {
      return store.getArtifactRef(scope) == null ? null : store.getArtifact(scope);
    },
    snapshots(runId) {
      if (store.getState(runId) == null) return null;
      return store.getSnapshotEvents(runId).map(toScrubberRow);
    },
    diffRange(runId, eventIdx, against) {
      const state = store.getState(runId);
      if (state == null) return { ok: false, reason: "run_not_found" };
      if (state.cwd == null) return { ok: false, reason: "no_worktree" };

      const snapshots = store.getSnapshotEvents(runId).map(toScrubberRow);
      const snapshotPos = snapshots.findIndex((s) => s.eventIdx === eventIdx);
      if (snapshotPos === -1) return { ok: false, reason: "snapshot_not_found" };
      const snapshot = snapshots[snapshotPos] as SnapshotItem;

      const base = state.diffBaseSha ?? state.baseGitSha;
      let fromSha: string;
      if (against === "base") {
        if (base == null || base.length === 0) return { ok: false, reason: "base_missing" };
        fromSha = base;
      } else if (against === "previous") {
        if (snapshotPos === 0) {
          if (base == null || base.length === 0) return { ok: false, reason: "base_missing" };
          fromSha = base;
        } else {
          fromSha = (snapshots[snapshotPos - 1] as SnapshotItem).commitSha;
        }
      } else {
        const againstIdx = parseEventIdx(against);
        if (againstIdx == null) return { ok: false, reason: "invalid_against" };
        const againstSnap = snapshots.find((s) => s.eventIdx === againstIdx);
        if (againstSnap == null) return { ok: false, reason: "snapshot_not_found" };
        fromSha = againstSnap.commitSha;
      }

      return { ok: true, cwd: state.cwd, fromSha, toSha: snapshot.commitSha };
    },
    eventsSince(runId, sinceSeq, limit) {
      return store.getEvents(runId, limit === undefined ? { sinceSeq } : { sinceSeq, limit });
    },
    explain(runId) {
      const state = store.getState(runId);
      if (state == null) return null;
      const events = store.getEvents(runId);
      const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
      const detail = runStateToDetail(state, events, wf?.name, wf?.source);
      detail.lastEventSeq = events.at(-1)?.seq ?? 0;
      const snapshots = store.getSnapshotEvents(runId).map(toScrubberRow);
      const rawSteps = eventsToSteps(events);
      const aggregated = attachStepAggregates(rawSteps, store.getStepAggregates(runId));
      const lastEventTs = events.length > 0 ? Math.max(...events.map((e) => e.ts)) : undefined;
      const stepsFull = fillOrphanDurations(aggregated, {
        lastEventTs,
        runIsTerminal: isTerminalStatus(state.status),
      });
      return buildExplanation(detail, events, snapshots, stepsFull);
    },
    globalFeedLatest(limit) {
      return store.getGlobalEventsLatest({ kindIn: FEED_EVENT_KINDS, limit });
    },
    globalFeedForward(cursor) {
      return store.getGlobalEventsForward({ ...cursor, kindIn: FEED_EVENT_KINDS });
    },
    globalFeedAtFloor(cursor) {
      return store.getGlobalEventsAtFloor({ ...cursor, kindIn: FEED_EVENT_KINDS });
    },
  };
}

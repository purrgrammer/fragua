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

import {
  type GetMessagesOpts,
  type IEventStore,
  isTerminal as isTerminalStatus,
  type ListRunSummaryRowsOpts,
  type NarrowMessage,
  type StoredEvent,
} from "@fragua/store";
import { runStateToDetail, runSummaryRowToSummary } from "./projections.ts";
import type { RunDetail, RunSummary } from "./schemas.ts";
import { type DiffRange, parseEventIdx, type SnapshotItem, toScrubberRow } from "./snapshots.ts";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations, type StepSnapshot } from "./steps.ts";

export interface ReadPlaneDeps {
  store: IEventStore;
}

export interface ReadPlane {
  /** SQL-backed list projection — one `RunSummary` per row, no per-row
   *  event-log fetch. Mirrors `GET /runs`. */
  runSummaries(opts?: ListRunSummaryRowsOpts): RunSummary[];
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
  /** Ordered snapshot scrubber feed, or `null` when the run is absent.
   *  Mirrors `GET /runs/:id/snapshots`. */
  snapshots(runId: string): SnapshotItem[] | null;
  /** Resolve a snapshot diff request into `(cwd, fromSha, toSha)`, or a
   *  refusal. Pure — picks the commit shas; the git diff is the caller's.
   *  Mirrors the resolution in `GET /runs/:id/snapshots/:eventIdx/diff`. */
  diffRange(runId: string, eventIdx: number, against: string): DiffRange;
}

export function makeReadPlane(deps: ReadPlaneDeps): ReadPlane {
  const { store } = deps;
  return {
    runSummaries(opts = {}) {
      return store.listRunSummaryRows(opts).map(runSummaryRowToSummary);
    },
    runDetail(runId) {
      const state = store.getState(runId);
      if (state == null) return null;
      const events = store.getEvents(runId);
      const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
      const detail = runStateToDetail(state, events, wf?.name, wf?.source);
      detail.lastEventSeq = events.at(-1)?.seq ?? 0;
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
  };
}

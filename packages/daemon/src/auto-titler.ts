// Auto-title summariser — fires once per run, right after `fact.run_started`.
//
// The title is a UI hint, not part of the causal state machine: it never
// bumps `run_state.version`, never fails a run, and never blocks the
// executor. We run the summariser as a fire-and-forget Promise, track
// every in-flight call in a Set, and the daemon's entrypoint calls
// `drain()` after the executor loop exits so pending title calls get a
// chance to finish — or respond to the shared shutdown signal — before
// the process dies.
//
// Emitting:
//   - `summary.started` / `summary.text_delta` / `summary.completed` and
//     `cost.recorded` ride under the synthetic node id `__summary.title`
//     via `appendObservabilityEvents`. This is the same event trail
//     per-node `summary=` calls produce — cost flows into the same run-
//     level ledger with no bespoke aggregation.
//   - On success we append one more observability event
//     `run.title_generated` and project the title onto
//     `run_state.title` via `setRunTitle`. Downstream lists (`/runs`,
//     SSE projections) read the column directly so listings don't
//     re-walk the event log per run.
//
// Failures are intentionally silent: the summariser is a "nice to have"
// — missing API keys, network blips, or an OFF config toggle all leave
// the run with `title = null`, and the UI falls back to the raw
// `routing.input` (the run's free-form description).

import { type EventType, type SummariseInput, type SummariserBackend, titleSyntheticNodeId } from "@swarm/core";
import type { IEventStore } from "@swarm/store";

export interface AutoTitlerOpts {
  /** Summariser implementation. When unset, `titleRun` is a no-op — the
   * daemon wires this from `.swarm/config.jsonc`'s `summariser:` block,
   * and omits the backend when no provider/model is configured. */
  backend?: SummariserBackend;
  /** Policy toggle — `autoTitle: false` in config disables even when a
   * backend is configured. Defaults to `true`. */
  enabled?: boolean;
  store: IEventStore;
  /** Tripped when the daemon starts shutting down. Passed into the
   * summariser call so in-flight title generation cancels cleanly. */
  shutdownSignal: AbortSignal;
  /** Optional cap on title chars; the backend prompt already asks for
   * short titles but this is a defence against chatty models. */
  maxTitleChars?: number;
}

export interface TitleRequest {
  runId: string;
  workflowSha: string;
  /** Raw `routing.input` text (the run's free-form description). When
   * empty, titling is skipped — there's nothing to summarise. */
  input: string;
  /** Workflow-level goal (graph.goal attr). Optional; passed to the
   * summariser to frame the title. */
  goal?: string;
}

const DEFAULT_MAX_TITLE_CHARS = 80;

export class AutoTitler {
  private readonly backend: SummariserBackend | undefined;
  private readonly enabled: boolean;
  private readonly store: IEventStore;
  private readonly shutdownSignal: AbortSignal;
  private readonly maxTitleChars: number;
  private readonly inflight = new Set<Promise<void>>();

  constructor(opts: AutoTitlerOpts) {
    this.backend = opts.backend;
    this.enabled = opts.enabled ?? true;
    this.store = opts.store;
    this.shutdownSignal = opts.shutdownSignal;
    this.maxTitleChars = opts.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS;
  }

  /** Fire title generation for `runId`. Returns immediately; the
   * resulting promise is tracked for graceful shutdown. Duplicate calls
   * for the same run are allowed — last writer wins on `run_state.title`
   * — but the executor only triggers on the single run_started boundary
   * so this doesn't actually race in practice. */
  titleRun(req: TitleRequest): void {
    if (!this.enabled || this.backend == null) return;
    if (req.input.length === 0) return;
    if (this.shutdownSignal.aborted) return;

    const task = this.runOne(req).catch(() => {
      // Silent: titles are best-effort. Any error was already observable
      // via the summary.completed event carrying `.error`, if it got
      // that far. A pre-emit throw (e.g., store unavailable) is dropped
      // deliberately — the run itself is not affected.
    });
    this.inflight.add(task);
    task.finally(() => {
      this.inflight.delete(task);
    });
  }

  /** Await every in-flight title call. Safe to call multiple times. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      const snapshot = Array.from(this.inflight);
      await Promise.allSettled(snapshot);
    }
  }

  private async runOne(req: TitleRequest): Promise<void> {
    const backend = this.backend;
    if (backend == null) return;
    const syntheticNodeId = titleSyntheticNodeId();

    const emit = async (type: EventType, payload: Record<string, unknown>, nodeId: string): Promise<void> => {
      try {
        this.store.appendObservabilityEvents(req.runId, [{ type, payload: { ...payload, nodeId } }]);
      } catch {
        // Ignore — the run may have been deleted mid-call, or the store
        // is shutting down. Either way, the title path drops silently.
      }
    };

    const input: SummariseInput = {
      purpose: "title",
      input: req.input,
      run_id: req.runId,
      workflow_sha: req.workflowSha,
      synthetic_node_id: syntheticNodeId,
      emit,
      signal: this.shutdownSignal,
    };
    if (req.goal !== undefined) input.goal = req.goal;

    const out = await backend.summarise(input);
    if (!out.ok) return;
    const title = sanitizeTitle(out.text, this.maxTitleChars);
    if (title.length === 0) return;

    try {
      this.store.appendObservabilityEvents(req.runId, [
        {
          type: "run.title_generated",
          payload: { title, summary_node_id: syntheticNodeId, nodeId: syntheticNodeId },
        },
      ]);
      this.store.setRunTitle(req.runId, title);
    } catch {
      // Same rationale as `emit` above — best-effort projection.
    }
  }
}

function sanitizeTitle(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars).trim();
}

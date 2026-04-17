// Shared fixtures for REST tests. Keeps the per-route test files readable.

import type { Event, EventSink } from "@swarm/core";
import type { RunReader } from "../src/ports.ts";

export function ev(partial: Partial<Event> & Pick<Event, "type">): Event {
  return {
    run_id: partial.run_id ?? "r1",
    type: partial.type,
    timestamp: partial.timestamp ?? "2024-01-01T00:00:00.000Z",
    workflow_sha: partial.workflow_sha ?? "sha-0",
    data: partial.data ?? {},
    ...(partial.node_id !== undefined ? { node_id: partial.node_id } : {}),
    ...(partial.session_id !== undefined ? { session_id: partial.session_id } : {}),
  };
}

/** In-memory RunReader for deterministic tests. */
export function memoryRunReader(runs: Record<string, Event[]>): RunReader {
  return {
    async listRuns(): Promise<string[]> {
      return Object.keys(runs);
    },
    async readEvents(runId: string): Promise<Event[] | undefined> {
      return runs[runId] ? [...runs[runId]] : undefined;
    },
  };
}

/** Minimal in-memory sink that records appended events. */
export class RecordingSink implements EventSink {
  readonly events: Event[] = [];
  async append(event: Event): Promise<void> {
    this.events.push(event);
  }
}

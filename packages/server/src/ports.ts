// Ports for @swarm/server.
//
// Trimmed for the DB-backed rearchitecture: InterviewGateway, ControlGateway,
// SkillReader, JobQueue, ProcessSupervisor are gone — the store + daemon own
// those responsibilities now. RunReader and WorkflowReader survive because
// the Workflows + Runs (née Pipelines) UI still reads legacy JSONL until
// M5 cutover.

import type { Event } from "@swarm/core";
import type { EventSource } from "@swarm/events";
import type { HealthDaemonInfo } from "./routes/health.ts";

export interface RunReader {
  /** Enumerate all run ids (usually directory names under `.swarm/runs/`). */
  listRuns(): Promise<string[]>;
  /** Load every event for a run. Returns undefined for unknown runs. */
  readEvents(runId: string): Promise<Event[] | undefined>;
}

export function runReaderFromSource(source: EventSource): RunReader {
  return {
    listRuns: () => source.listRuns(),
    readEvents: (runId) => source.readRun(runId),
  };
}

export function sourceFromRunReader(reader: RunReader): EventSource {
  return {
    listRuns: () => reader.listRuns(),
    readRun: (runId) => reader.readEvents(runId),
  };
}

export interface WorkflowSummary {
  name: string;
  path: string;
  sha: string;
  label?: string;
}

export interface WorkflowDetail extends WorkflowSummary {
  source: string;
}

export interface WorkflowReader {
  list(): Promise<WorkflowSummary[]>;
  read(name: string): Promise<WorkflowDetail | undefined>;
}

export interface ServerPorts {
  runReader?: RunReader;
  workflowReader?: WorkflowReader;
  daemonInfo?: () => HealthDaemonInfo | Promise<HealthDaemonInfo>;
}

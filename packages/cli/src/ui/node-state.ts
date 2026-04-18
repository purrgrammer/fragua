// Pure node-state reducer — mirrors the shape of `deriveDetail` in
// @swarm/server (packages/server/src/routes/pipelines.ts). Extracted here
// so the TUI doesn't need to pull in the entire HTTP server package just
// to derive which nodes are running / completed / failed.
//
// Kept intentionally tiny and strict-typed: one event in, state out,
// no side effects. The caller owns the Map and mutates it via
// `foldNodeState(state, event)`. Unit tests feed a canned event sequence
// and assert the resulting Map.

import type { Event } from "@swarm/core";

export type NodeLifecycleState = "pending" | "running" | "completed" | "failed" | "skipped" | "retrying";

export interface NodeStateRecord {
  nodeId: string;
  state: NodeLifecycleState;
  lastEventSeq: number;
}

/**
 * Apply a single event to a node-state map (in-place). Returns the same
 * map for chaining. Events without `node_id` are ignored. `seq` is the
 * event's 1-based index in the stream — stored verbatim so callers can
 * find "which node moved most recently".
 */
export function foldNodeState(
  states: Map<string, NodeStateRecord>,
  ev: Event,
  seq: number,
): Map<string, NodeStateRecord> {
  if (!ev.node_id) return states;
  const prev = states.get(ev.node_id);
  const next: NodeStateRecord = prev
    ? { ...prev, lastEventSeq: seq }
    : { nodeId: ev.node_id, state: "pending", lastEventSeq: seq };
  switch (ev.type) {
    case "node.started":
      next.state = "running";
      break;
    case "node.completed": {
      // Mirror the conversation reducer: outcome=fail flips to "failed"
      // even though the lifecycle event is "node.completed".
      const outcome = (ev.data as { outcome?: { status?: string } } | undefined)?.outcome;
      next.state = outcome?.status === "fail" ? "failed" : "completed";
      break;
    }
    case "node.failed":
      next.state = "failed";
      break;
    case "node.skipped":
      next.state = "skipped";
      break;
    case "node.retrying":
      next.state = "retrying";
      break;
    default:
      break;
  }
  states.set(ev.node_id, next);
  return states;
}

/** Fold an event iterable into a fresh state map. */
export function buildNodeStates(events: Iterable<Event>): Map<string, NodeStateRecord> {
  const out = new Map<string, NodeStateRecord>();
  let i = 0;
  for (const ev of events) {
    i += 1;
    foldNodeState(out, ev, i);
  }
  return out;
}

/** Node with the highest `lastEventSeq` that is currently running. Returns
 * undefined when nothing is running. Used to pick the "active" highlight. */
export function activeNodeId(states: Map<string, NodeStateRecord>): string | undefined {
  let best: NodeStateRecord | undefined;
  for (const s of states.values()) {
    if (s.state !== "running") continue;
    if (!best || s.lastEventSeq > best.lastEventSeq) best = s;
  }
  return best?.nodeId;
}

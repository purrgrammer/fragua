// Checkpoint: serialized snapshot saved after each node transition.
// See docs/SPEC.md §3.6.

import { type Static, Type } from "@sinclair/typebox";
import { OutcomeSchema } from "./outcome.ts";

export const CHECKPOINT_SCHEMA_VERSION = 1;

export const CheckpointSchema = Type.Object(
  {
    version: Type.Literal(CHECKPOINT_SCHEMA_VERSION),
    run_id: Type.String(),
    workflow_sha: Type.String(),
    current_node: Type.String(),
    completed_nodes: Type.Array(Type.String()),
    node_outcomes: Type.Record(Type.String(), OutcomeSchema),
    context: Type.Record(Type.String(), Type.Any()),
    retry_counts: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    /** Serialized pi-mono session state keyed by thread_id. Opaque to @swarm/core. */
    pi_sessions: Type.Record(Type.String(), Type.Any()),
    saved_at: Type.String(),
  },
  { $id: "Checkpoint" },
);

export type Checkpoint = Static<typeof CheckpointSchema>;

/**
 * Port for checkpoint persistence. Wave 6 wires the JSONL adapter in
 * `@swarm/events` (`JsonlCheckpointStore`); a future Postgres sink will
 * implement the same two methods so resume works identically across
 * backing stores.
 */
export interface CheckpointStore {
  /** Write (or overwrite) the checkpoint for a run. Must be atomic
   * enough that a mid-write crash leaves either the previous
   * checkpoint or the new one — never a torn JSON file. */
  save(runId: string, checkpoint: Checkpoint): Promise<void>;
  /** Read the latest checkpoint for a run. Returns `undefined` when
   * the run has never been checkpointed. */
  load(runId: string): Promise<Checkpoint | undefined>;
}

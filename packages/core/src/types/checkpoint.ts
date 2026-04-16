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

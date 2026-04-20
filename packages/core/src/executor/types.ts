// CodergenBackend / CodergenInput — the contract @swarm/agent's
// PiCodergenBackend implements so makeCodergenHandler can drive it inside
// a HandlerContext.

import type { ContextMap } from "../types/context.ts";
import type { EventType } from "../types/events.ts";
import type { FidelityMode } from "../types/fidelity.ts";
import type { Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";

export interface CodergenBackend {
  run(input: CodergenInput): Promise<Outcome>;
}

export interface CodergenInput {
  node: Node;
  prompt: string;
  context: ContextMap;
  thread_id: string | undefined;
  fidelity: FidelityMode;
  signal: AbortSignal;
  run_id: string;
  workflow_sha: string;
  /** Backend-emitted sub-events (cost.recorded, agent.message_end, …).
   * The handler-bridge collects cost + assistant/tool messages from
   * these callbacks; unrecognised types are ignored. */
  emit?: (type: EventType, data: Record<string, unknown>) => Promise<void>;
  /** Optional loop iteration metadata for handlers dispatched from a loop. */
  iteration?: { n: number; max: number };
}

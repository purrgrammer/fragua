// Collects side-effect facts emitted inside the handler body so the
// executor can commit them in the same transaction as node_completed.

import type { handler } from "@swarm/core";
import type { FactEvent } from "@swarm/store";

type SideEffectRecorder = handler.SideEffectRecorder;

export class CollectingRecorder implements SideEffectRecorder {
  private readonly facts: FactEvent[] = [];

  constructor(
    private readonly nodeId: string,
    private readonly iteration: number,
  ) {}

  recordIntent(params: {
    toolName: string;
    argsHash: string;
    attempt: number;
    idempotencyKey: string;
  }): void {
    this.facts.push({
      type: "fact.side_effect_intent",
      payload: {
        nodeId: this.nodeId,
        iteration: this.iteration,
        toolName: params.toolName,
        argsHash: params.argsHash,
        attempt: params.attempt,
        idempotencyKey: params.idempotencyKey,
      },
    });
  }

  recordDone(params: {
    idempotencyKey: string;
    artifactKey: string;
    tokens?: number;
    costUsd?: number;
  }): void {
    const payload: Extract<
      FactEvent,
      { type: "fact.side_effect_done" }
    >["payload"] = {
      idempotencyKey: params.idempotencyKey,
      artifactKey: params.artifactKey,
    };
    if (params.tokens !== undefined) payload.tokens = params.tokens;
    if (params.costUsd !== undefined) payload.costUsd = params.costUsd;
    this.facts.push({ type: "fact.side_effect_done", payload });
  }

  recordFailed(params: {
    idempotencyKey: string;
    errorCode: string;
    retriable: boolean;
  }): void {
    this.facts.push({
      type: "fact.side_effect_failed",
      payload: {
        idempotencyKey: params.idempotencyKey,
        errorCode: params.errorCode,
        retriable: params.retriable,
      },
    });
  }

  drain(): FactEvent[] {
    return this.facts.splice(0);
  }
}

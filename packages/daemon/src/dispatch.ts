// Node-kind → HandlerSpec dispatch.
//
// The daemon keeps a registry of HandlerSpecs keyed by node id. The simple
// impl registers one spec per (workflow, nodeId) pair; callers responsible
// for wiring. No graph parsing happens here — that stays in core/parser.

import type { handler } from "@swarm/core";

type HandlerSpec = handler.HandlerSpec;

export class Dispatcher {
  private readonly specs = new Map<string, HandlerSpec>();

  register(workflowSha: string, nodeId: string, spec: HandlerSpec): void {
    const key = keyOf(workflowSha, nodeId);
    if (this.specs.has(key)) {
      throw new Error(`handler already registered for ${key}`);
    }
    this.specs.set(key, spec);
  }

  get(workflowSha: string, nodeId: string): HandlerSpec {
    const key = keyOf(workflowSha, nodeId);
    const spec = this.specs.get(key);
    if (spec == null) {
      throw new Error(`no handler registered for ${key}`);
    }
    return spec;
  }

  has(workflowSha: string, nodeId: string): boolean {
    return this.specs.has(keyOf(workflowSha, nodeId));
  }
}

function keyOf(workflowSha: string, nodeId: string): string {
  return `${workflowSha}::${nodeId}`;
}

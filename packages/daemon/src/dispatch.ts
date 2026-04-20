// Node-kind → HandlerSpec dispatch.
//
// The daemon keeps a registry of HandlerSpecs keyed by node id. The simple
// impl registers one spec per (workflow, nodeId) pair; callers responsible
// for wiring. No graph parsing happens here — that stays in core/parser.

import type * as handler from "@swarm/core/handler";

type HandlerSpec = handler.HandlerSpec;

/**
 * Optional fallback: when the dispatcher has no registered spec for a
 * (workflowSha, nodeId) pair, this resolver builds one on demand. The
 * auto-dispatcher uses it to lazily parse a DOT workflow the first
 * time the daemon sees it.
 */
export type DispatcherResolver = (
  workflowSha: string,
  nodeId: string,
) => HandlerSpec | null;

export class Dispatcher {
  private readonly specs = new Map<string, HandlerSpec>();
  private resolver: DispatcherResolver | null = null;

  setResolver(resolver: DispatcherResolver | null): void {
    this.resolver = resolver;
  }

  register(workflowSha: string, nodeId: string, spec: HandlerSpec): void {
    const key = keyOf(workflowSha, nodeId);
    if (this.specs.has(key)) {
      throw new Error(`handler already registered for ${key}`);
    }
    this.specs.set(key, spec);
  }

  get(workflowSha: string, nodeId: string): HandlerSpec {
    const key = keyOf(workflowSha, nodeId);
    const cached = this.specs.get(key);
    if (cached != null) return cached;
    if (this.resolver != null) {
      const resolved = this.resolver(workflowSha, nodeId);
      if (resolved != null) {
        this.specs.set(key, resolved);
        return resolved;
      }
    }
    throw new Error(`no handler registered for ${key}`);
  }

  has(workflowSha: string, nodeId: string): boolean {
    if (this.specs.has(keyOf(workflowSha, nodeId))) return true;
    if (this.resolver != null) {
      const resolved = this.resolver(workflowSha, nodeId);
      if (resolved != null) {
        this.specs.set(keyOf(workflowSha, nodeId), resolved);
        return true;
      }
    }
    return false;
  }
}

function keyOf(workflowSha: string, nodeId: string): string {
  return `${workflowSha}::${nodeId}`;
}

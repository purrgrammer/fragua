// Event sink port and the in-memory adapter (pure, no I/O).
// Concrete sinks that touch disk or the network live in @swarm/events.

import type { Event } from "../types/events.ts";

export interface EventSink {
  /** Append an event. Implementations must preserve insertion order. */
  append(event: Event): Promise<void>;
  /** Optional close/flush hook called at end of run. */
  close?(): Promise<void>;
}

/** In-memory sink for tests and replay. Events are held in insertion order. */
export class InMemorySink implements EventSink {
  private readonly events: Event[] = [];

  async append(event: Event): Promise<void> {
    this.events.push(event);
  }

  /** Snapshot of events (defensive copy). */
  snapshot(): Event[] {
    return [...this.events];
  }

  byType(type: Event["type"]): Event[] {
    return this.events.filter((e) => e.type === type);
  }

  byNode(nodeId: string): Event[] {
    return this.events.filter((e) => e.node_id === nodeId);
  }

  count(): number {
    return this.events.length;
  }

  clear(): void {
    this.events.length = 0;
  }
}

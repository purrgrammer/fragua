// In-memory message store keyed by `thread_id`. Each `PiCodergenBackend`
// holds one of these so nodes that share a `thread_id` can actually share
// a transcript — pi-agent-core's `sessionId` is only a provider cache hint,
// it does NOT restore messages on its own. Without this store, every
// `backend.run()` would start with an empty transcript and `fidelity=full`
// (the SPEC's "session reused via thread_id") would be a lie.
//
// Scope for Wave 1:
// - in-process only; reset when the backend is reconstructed
// - unbounded; a long-running pipeline that accumulates huge transcripts
//   pays the memory cost. Compact / summary fidelities are the pressure
//   valve; disk persistence lands with checkpoint.pi_sessions (Wave 4+).

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export class MessageStore {
  private readonly map = new Map<string, AgentMessage[]>();

  /** Return a detached copy of the messages associated with a thread, or
   * `[]` if no messages have been stored under that key. Detached so
   * downstream mutation does not leak back into the store. */
  get(threadId: string): AgentMessage[] {
    const stored = this.map.get(threadId);
    return stored ? stored.slice() : [];
  }

  has(threadId: string): boolean {
    return this.map.has(threadId);
  }

  /** Replace the entire transcript for a thread. Overwriting (rather than
   * appending) is correct because pi-agent-core's `agent.state.messages`
   * always includes the full run-so-far transcript — the last call's
   * output is the authoritative tail. */
  set(threadId: string, messages: readonly AgentMessage[]): void {
    this.map.set(threadId, messages.slice());
  }

  /** Drop the transcript for a thread (used by `context="fresh"` on a node
   * that shares a `thread_id` but wants to explicitly reset history). */
  delete(threadId: string): void {
    this.map.delete(threadId);
  }

  clear(): void {
    this.map.clear();
  }

  /** Thread ids currently stored. Exposed for test ergonomics and for
   * future checkpoint serialisation. */
  threadIds(): string[] {
    return [...this.map.keys()];
  }
}

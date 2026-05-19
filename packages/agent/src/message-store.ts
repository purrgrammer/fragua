// In-memory message store keyed by `(run_id, thread_id)`. Each
// `PiLlmBackend` holds one of these so nodes within a run that share
// a `thread_id` can actually share a transcript — pi-agent-core's
// `sessionId` is only a provider cache hint, it does NOT restore messages
// on its own. Without this store, every `backend.run()` would start with
// an empty transcript and threaded nodes (the SPEC's "session reused via
// thread_id") would be a lie.
//
// The runId is part of the key because backends are shared across runs
// (one `PiLlmBackend` per (workflow, node) — see
// `packages/cli/src/commands/daemon.ts`). Two concurrent runs hitting the
// same backend with the same thread_id (e.g. `thread_id="dev"` in
// build-feature.dot) would clobber each other's transcripts without the
// runId component.
//
// Scope:
// - in-process only; reset when the backend is reconstructed.
// - unbounded; a long-running run that accumulates huge transcripts pays
//   the memory cost. `compact` / `summary:*` fidelities are the pressure
//   valve. Disk persistence via `checkpoint.pi_sessions` is not yet wired
//   (see serialise/hydrate below for the round-trip shape).

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// NUL is not a valid character in any legitimate runId or threadId, so
// using it as the composite-key delimiter is collision-safe.
const KEY_SEP = "\x00";

function makeKey(runId: string, threadId: string): string {
  return `${runId}${KEY_SEP}${threadId}`;
}

export class MessageStore {
  private readonly map = new Map<string, AgentMessage[]>();

  /** Return a detached copy of the messages associated with a
   * (runId, threadId), or `[]` if nothing has been stored under that key.
   * Detached so downstream mutation does not leak back into the store. */
  get(runId: string, threadId: string): AgentMessage[] {
    const stored = this.map.get(makeKey(runId, threadId));
    return stored ? stored.slice() : [];
  }

  has(runId: string, threadId: string): boolean {
    return this.map.has(makeKey(runId, threadId));
  }

  /** Replace the entire transcript for a (runId, threadId). Overwriting
   * (rather than appending) is correct because pi-agent-core's
   * `agent.state.messages` always includes the full run-so-far
   * transcript — the last call's output is the authoritative tail. */
  set(runId: string, threadId: string, messages: readonly AgentMessage[]): void {
    this.map.set(makeKey(runId, threadId), messages.slice());
  }

  /** Drop the transcript for a (runId, threadId) (used by
   * `context="fresh"` on a node that shares a `thread_id` but wants to
   * explicitly reset history). */
  delete(runId: string, threadId: string): void {
    this.map.delete(makeKey(runId, threadId));
  }

  /** Drop every thread transcript associated with a run. Called by the
   * executor when a run reaches a terminal status so concurrent-run
   * bookkeeping does not leak across daemon restarts. */
  clearRun(runId: string): void {
    const prefix = `${runId}${KEY_SEP}`;
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  clear(): void {
    this.map.clear();
  }

  /** (runId, threadId) pairs currently stored. Exposed for test ergonomics
   * and for future checkpoint serialisation. */
  keys(): Array<{ runId: string; threadId: string }> {
    const out: Array<{ runId: string; threadId: string }> = [];
    for (const k of this.map.keys()) {
      const sep = k.indexOf(KEY_SEP);
      if (sep < 0) continue;
      out.push({ runId: k.slice(0, sep), threadId: k.slice(sep + 1) });
    }
    return out;
  }

  /** Serialise into a JSON-safe plain object for `checkpoint.pi_sessions`.
   * Keys are the composite `runId\x00threadId` strings — opaque to
   * @swarm/core but round-trippable by `hydrate()` below. */
  serialise(): Record<string, AgentMessage[]> {
    const out: Record<string, AgentMessage[]> = {};
    for (const [k, v] of this.map.entries()) out[k] = v.slice();
    return out;
  }

  /** Inverse of `serialise`. Replaces the current store contents with
   * the snapshot — used on resume so prior transcripts rejoin the store
   * before the first post-resume backend.run(). */
  hydrate(snapshot: Record<string, unknown>): void {
    this.map.clear();
    for (const [k, v] of Object.entries(snapshot)) {
      if (Array.isArray(v)) this.map.set(k, v.slice() as AgentMessage[]);
    }
  }
}

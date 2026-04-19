// usePendingSteers — local optimistic queue for in-flight `/steer` calls.
//
// The server accepts steer requests with 202 Accepted + `{ id }`; the
// steer only materializes in the run's event stream once the executor
// tails `control.jsonl` and emits `control.requested(steer)` carrying
// the same id. That round-trip is usually sub-second but can take
// longer under load, and on a failed request there's no event at all.
//
// This hook owns the small gap: it tracks messages the user submitted
// until an event matching either the request id OR (legacy runs) the
// message text appears in the event stream, then drops the entry. On
// failure the entry is flipped to `state: "failed"` with an error
// message and kept around so the UI can surface retry / dismiss.
//
// Purity: the hook is a plain state container + a reconciliation effect
// keyed on the caller-supplied events array. No network, no timers,
// same input ⇒ same observable state. Callers own the API call.

import { useEffect, useRef, useState } from "react";

export interface PendingSteer {
  id: string;
  message: string;
  state: "pending" | "failed";
  error?: string;
}

/** Minimal event shape we reconcile against. Intentionally narrower than
 * `RawEvent` so the hook doesn't import the whole conversation reducer —
 * tests can feed plain literals. */
export interface ReconcileEvent {
  type: string;
  data?: Record<string, unknown> | null;
}

export interface UsePendingSteersResult {
  pending: readonly PendingSteer[];
  /** Add a new entry in `"pending"` state. Appended to the end. */
  enqueue: (id: string, message: string) => void;
  /** Flip `id` to `"failed"` with an attached error string. No-op if not present. */
  markFailed: (id: string, error: string) => void;
  /** Drop `id` regardless of state. No-op if not present. */
  remove: (id: string) => void;
}

/**
 * Track a queue of submitted steers and reconcile against `events`.
 *
 * An entry is dropped from the queue when either:
 *   1. a `control.requested` event with `data.command === "steer"` and
 *      `data.id === entry.id` appears, OR
 *   2. (legacy) a `steering.injected` event with `data.message ===
 *      entry.message` appears — covers runs that predate the control
 *      channel and never round-tripped an id.
 *
 * Entries in `"failed"` state are NOT auto-removed — the user must
 * decide to retry or dismiss.
 */
export function usePendingSteers(events: readonly ReconcileEvent[]): UsePendingSteersResult {
  const [pending, setPending] = useState<readonly PendingSteer[]>([]);

  // Track how much of `events` we've already scanned so each render only
  // processes new tail events — important because the events array can
  // grow to tens of thousands of entries on a long run.
  const scannedRef = useRef(0);

  // If the caller swaps the events array entirely (new runId, or reset),
  // restart scanning from the beginning.
  const lastArrayRef = useRef<readonly ReconcileEvent[] | null>(null);

  useEffect(() => {
    if (lastArrayRef.current !== events) {
      // Array identity changed. If the new array is a strict suffix of
      // what we've seen, we can keep `scannedRef`; otherwise rescan from
      // zero. In practice the hook above this passes a fresh array each
      // update, and we rely on the length comparison in the scan below.
      if (!events || events.length < scannedRef.current) {
        scannedRef.current = 0;
      }
      lastArrayRef.current = events;
    }

    if (!events || events.length <= scannedRef.current) return;

    // Collect the ids/messages of events that should clear pending entries.
    const clearedIds = new Set<string>();
    const clearedMessages = new Set<string>();

    for (let i = scannedRef.current; i < events.length; i++) {
      const ev = events[i];
      if (!ev) continue;
      const data = ev.data ?? undefined;

      if (ev.type === "control.requested" && data) {
        const command = data["command"];
        if (command === "steer") {
          const id = data["id"];
          if (typeof id === "string" && id.length > 0) clearedIds.add(id);
        }
        continue;
      }
      if (ev.type === "steering.injected" && data) {
        const message = data["message"];
        if (typeof message === "string" && message.length > 0) clearedMessages.add(message);
      }
    }

    scannedRef.current = events.length;

    if (clearedIds.size === 0 && clearedMessages.size === 0) return;

    setPending((prev) => {
      const next = prev.filter((entry) => {
        // Failed entries stick around — user decides to retry or dismiss.
        if (entry.state !== "pending") return true;
        if (clearedIds.has(entry.id)) return false;
        if (clearedMessages.has(entry.message)) return false;
        return true;
      });
      // Preserve reference if nothing changed so callers memoizing on
      // `pending` don't see spurious updates.
      return next.length === prev.length ? prev : next;
    });
  }, [events]);

  const enqueue = (id: string, message: string): void => {
    setPending((prev) => [...prev, { id, message, state: "pending" }]);
  };

  const markFailed = (id: string, error: string): void => {
    setPending((prev) => {
      let changed = false;
      const next = prev.map((entry) => {
        if (entry.id !== id) return entry;
        changed = true;
        return { ...entry, state: "failed" as const, error };
      });
      return changed ? next : prev;
    });
  };

  const remove = (id: string): void => {
    setPending((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      return next.length === prev.length ? prev : next;
    });
  };

  return { pending, enqueue, markFailed, remove };
}

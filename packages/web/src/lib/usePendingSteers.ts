// usePendingSteers — local optimistic queue for in-flight `/steer` calls.
//
// The server replies to `POST /runs/:id/steer` with `{ seq }` from
// `appendIntent`. The daemon eventually folds the steer into a turn,
// at which point a user-role message carrying the steer's text appears
// in the run's messages table. That arrival IS the "applied" signal
// the queue waits for.
//
// This hook owns the gap between submit-click and message-appears:
//
//   1. Caller `enqueue(localId, text)` immediately on submit.
//   2. The hook drops the entry the moment a user-role message with
//      content equal to `text` shows up in the messages array.
//
// On POST failure the entry flips to `state: "failed"` with an error
// message and stays around so the UI can surface retry / dismiss.
// Reconciliation never auto-removes a failed entry.
//
// Purity: plain state container + a reconciliation effect keyed on the
// caller-supplied messages array. No network, no timers, same input ⇒
// same observable state.

import { useEffect, useRef, useState } from "react";
import type { RunMessageRow } from "./api.ts";

export interface PendingSteer {
  id: string;
  message: string;
  state: "pending" | "failed";
  error?: string;
}

export interface UsePendingSteersResult {
  pending: readonly PendingSteer[];
  enqueue: (id: string, message: string) => void;
  markFailed: (id: string, error: string) => void;
  remove: (id: string) => void;
}

/** Extract the plain text of a user-role message, ignoring image parts.
 * Returns null for non-user messages or messages without textual content. */
function userMessageText(row: RunMessageRow): string | null {
  const m = row.content;
  if (m.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  for (const part of m.content) {
    if (part.type === "text") return part.text;
  }
  return null;
}

/** Track a queue of submitted steers and reconcile against the run's
 * messages. An entry drops when a user-role message with matching text
 * appears. Failed entries stick around until manually dismissed. */
export function usePendingSteers(messages: readonly RunMessageRow[]): UsePendingSteersResult {
  const [pending, setPending] = useState<readonly PendingSteer[]>([]);

  // Track how far we've scanned the messages array — each render only
  // processes the new tail. Reset to 0 when the caller swaps the array
  // (new runId, server resync, etc.).
  const scannedRef = useRef(0);
  const lastArrayRef = useRef<readonly RunMessageRow[] | null>(null);

  useEffect(() => {
    if (lastArrayRef.current !== messages) {
      if (!messages || messages.length < scannedRef.current) {
        scannedRef.current = 0;
      }
      lastArrayRef.current = messages;
    }

    if (!messages || messages.length <= scannedRef.current) return;

    const arrivedTexts = new Set<string>();
    for (let i = scannedRef.current; i < messages.length; i++) {
      const row = messages[i];
      if (!row) continue;
      const text = userMessageText(row);
      if (text != null && text.length > 0) arrivedTexts.add(text);
    }
    scannedRef.current = messages.length;

    if (arrivedTexts.size === 0) return;

    setPending((prev) => {
      const next = prev.filter((entry) => {
        if (entry.state !== "pending") return true;
        return !arrivedTexts.has(entry.message);
      });
      return next.length === prev.length ? prev : next;
    });
  }, [messages]);

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

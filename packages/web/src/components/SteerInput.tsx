// SteerInput — mid-run steering composer for a running pipeline.
//
// Renders a compact stack of in-flight steer messages above a standard
// AI-Elements `PromptInput`. On submit, we POST to `/steer` via
// `steerRun`; the server replies 202 with an `id`, which we enqueue
// into `usePendingSteers`. That hook watches the run's event stream
// and drops the entry the moment a matching `control.requested(steer)`
// (or legacy `steering.injected`) event arrives — at which point the
// conversation reducer has already rendered the steer as a user
// message inside the active turn, so the pending row gracefully
// dissolves into the thread.
//
// On network failure, the entry flips to `"failed"` with an error
// message and a retry / dismiss affordance. Retry re-fires `steerRun`
// with the same text and replaces the entry with the new id.
//
// Styling follows the Swarm design language: no shadows / gradients,
// hairline borders, `bg-sw-surface` for the surface, state-only accents.

import { useMutation } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { type FormEvent, useId } from "react";
import { steerRun } from "../lib/api.ts";
import type { ReconcileEvent } from "../lib/usePendingSteers.ts";
import { type PendingSteer, usePendingSteers } from "../lib/usePendingSteers.ts";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./ai-elements/prompt-input.tsx";

export interface SteerInputProps {
  runId: string;
  /** Event stream for reconciliation. Passed through to `usePendingSteers`. */
  events: readonly ReconcileEvent[];
}

export default function SteerInput({ runId, events }: SteerInputProps): JSX.Element {
  const { pending, enqueue, markFailed, remove } = usePendingSteers(events);
  const labelId = useId();

  const mutation = useMutation({
    mutationFn: async (vars: { message: string; localId: string }) => {
      const result = await steerRun(runId, vars.message);
      return { id: result.id, localId: vars.localId, message: vars.message };
    },
    onSuccess: (result, vars) => {
      // Replace the local placeholder id with the server-issued id so
      // the event-stream reconciliation can match by id. We do this as
      // a drop-and-enqueue rather than an in-place rename to keep the
      // queue's API surface small.
      remove(vars.localId);
      enqueue(result.id, result.message);
    },
    onError: (err, vars) => {
      const message = err instanceof Error ? err.message : String(err);
      markFailed(vars.localId, message);
    },
  });

  const handleSubmit = (msg: PromptInputMessage, e: FormEvent<HTMLFormElement>): void => {
    const text = msg.text.trim();
    if (text === "") return;
    // Enqueue with a synthetic local id immediately so the row renders
    // before the server responds. `onSuccess` will swap it for the
    // server-issued id; `onError` will flip it to `"failed"`.
    const localId = `local-${nanoid(8)}`;
    enqueue(localId, text);
    mutation.mutate({ message: text, localId });
    // Reset the form so the textarea clears for the next steer.
    e.currentTarget.reset();
  };

  const retry = (entry: PendingSteer): void => {
    remove(entry.id);
    const localId = `local-${nanoid(8)}`;
    enqueue(localId, entry.message);
    mutation.mutate({ message: entry.message, localId });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="steer-input">
      {pending.length > 0 && (
        <ul
          aria-labelledby={labelId}
          className="flex flex-col gap-1 rounded-sw-card border border-sw-border bg-sw-surface p-2"
          data-testid="steer-pending-list"
        >
          <li id={labelId} className="sr-only">
            Pending steering messages
          </li>
          {pending.map((entry) => (
            <PendingRow key={entry.id} entry={entry} onRetry={() => retry(entry)} onDismiss={() => remove(entry.id)} />
          ))}
        </ul>
      )}

      <PromptInput onSubmit={handleSubmit} data-testid="steer-form">
        <PromptInputTextarea
          placeholder="Steer the run — add context or redirect the agent…"
          data-testid="steer-textarea"
          aria-label="Steering message"
        />
        <PromptInputSubmit data-testid="steer-submit" />
      </PromptInput>
    </div>
  );
}

function PendingRow({
  entry,
  onRetry,
  onDismiss,
}: {
  entry: PendingSteer;
  onRetry: () => void;
  onDismiss: () => void;
}): JSX.Element {
  const isFailed = entry.state === "failed";
  return (
    <li
      className="flex items-start gap-2 text-sw-sm"
      data-testid={`steer-pending-${entry.id}`}
      data-state={entry.state}
    >
      <span
        aria-hidden
        className={
          isFailed
            ? "mt-1 size-2 shrink-0 rounded-full bg-sw-accent-error"
            : "sw-pulse mt-1 size-2 shrink-0 rounded-full bg-sw-accent-thinking"
        }
      />
      <span className="min-w-0 flex-1 truncate text-sw-text" title={entry.message}>
        {entry.message}
      </span>
      {isFailed ? (
        <span className="flex shrink-0 items-baseline gap-2 text-sw-xs">
          <span
            className="text-sw-muted"
            style={{ color: "var(--sw-accent-error)" }}
            title={entry.error ?? "steer failed"}
            data-testid={`steer-pending-${entry.id}-error`}
          >
            failed
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="text-sw-muted hover:text-sw-text"
            data-testid={`steer-pending-${entry.id}-retry`}
          >
            retry
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="text-sw-muted hover:text-sw-text"
            data-testid={`steer-pending-${entry.id}-dismiss`}
          >
            dismiss
          </button>
        </span>
      ) : (
        <span className="shrink-0 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">pending</span>
      )}
    </li>
  );
}

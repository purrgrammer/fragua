// SteerInput — mid-run steering composer for a running run.
//
// Renders a compact stack of in-flight steer messages above a standard
// AI-Elements `PromptInput`. On submit, we POST to `/steer` via
// `steerRun`; the server replies `{ seq }` after persisting the
// `intent.steering_requested`. `usePendingSteers` watches the run's
// messages array and drops the local entry the moment a user-role
// message with the steer's text shows up — at which point the daemon
// has folded the steer into a dispatch and the agent will see it on
// its next turn.
//
// On network failure, the entry flips to `"failed"` with an error
// message and a retry / dismiss affordance. Retry re-fires `steerRun`
// with the same text under a fresh local id.
//
// Styling follows the Fragua design language: no shadows / gradients,
// hairline borders, `bg-sw-surface` for the surface, state-only accents.

import { useMutation } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { type FormEvent, useId } from "react";
import { type RunMessageRow, steerRun } from "../lib/api.ts";
import { toastError } from "../lib/toast.ts";
import { type PendingSteer, usePendingSteers } from "../lib/usePendingSteers.ts";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./ai-elements/prompt-input.tsx";

export interface SteerInputProps {
  runId: string;
  /** Run messages array — passed through to `usePendingSteers` so a
   * user-role message with matching text drains the local entry. */
  messages: readonly RunMessageRow[];
}

export default function SteerInput({ runId, messages }: SteerInputProps): JSX.Element {
  const { pending, enqueue, markFailed, remove } = usePendingSteers(messages);
  const labelId = useId();

  const mutation = useMutation({
    mutationFn: async (vars: { message: string; localId: string }) => {
      await steerRun(runId, vars.message);
    },
    onError: (err, vars) => {
      const message = err instanceof Error ? err.message : String(err);
      markFailed(vars.localId, message);
      toastError(err);
    },
  });

  const handleSubmit = (msg: PromptInputMessage, e: FormEvent<HTMLFormElement>): void => {
    const text = msg.text.trim();
    if (text === "") return;
    // Enqueue with a synthetic local id immediately so the row renders
    // before the server responds. `onSuccess` will attach the server's
    // seq; `onError` will flip the entry to `"failed"`.
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
        <PromptInputFooter>
          <PromptInputSubmit data-testid="steer-submit" />
        </PromptInputFooter>
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

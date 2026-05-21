// RunActions — compact dropdown + confirm dialog for worktree inbox actions.
//
// Renders nothing unless inboxStatus === "pending". Two actions: Accept
// (replay the run's commits onto the operator's current branch + stage the
// uncommitted tail to commit) and Discard. Neither takes input — accept's
// target is the operator's current branch and the commit message is theirs.
//
// The confirm dialog is rendered inline (not portaled) so it is accessible to
// tests and to keyboard/focus management in the host tree.
//
// Two-component split: RunActions is the public guard (returns null when not
// pending); RunActionsInner holds all hooks so React Rules-of-Hooks are
// satisfied — hooks can never appear after an early return.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { RunSummary } from "../lib/api.ts";
import { acceptRun, discardRun } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { extractErrorMessage, toast } from "../lib/toast.ts";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

type ActionKind = "accept" | "discard";

export type RunActionsRun = Pick<RunSummary, "runId" | "inboxStatus">;

/** Test-only prop: directly open one of the confirm dialogs without going
 * through the dropdown (Radix portals are invisible in happy-dom). */
export type RunActionsTestOpenAction = ActionKind | null;

function errorMsg(err: unknown): string {
  return extractErrorMessage(err, "Unknown error");
}

/** Public entry point. Returns null when `inboxStatus !== "pending"` so
 * callers can unconditionally mount it and it self-hides. The actual
 * hook-heavy logic lives in RunActionsInner to keep hooks unconditional. */
export function RunActions({
  row,
  _testOpenAction,
}: {
  row: RunActionsRun;
  /** @internal test-only: bypass dropdown and directly open a form. */
  _testOpenAction?: RunActionsTestOpenAction;
}): JSX.Element | null {
  if (row.inboxStatus !== "pending") return null;
  return <RunActionsInner row={row} _testOpenAction={_testOpenAction ?? null} />;
}

function RunActionsInner({
  row,
  _testOpenAction,
}: {
  row: RunActionsRun;
  _testOpenAction: RunActionsTestOpenAction;
}): JSX.Element {
  const qc = useQueryClient();
  const [openAction, setOpenAction] = useState<ActionKind | null>(_testOpenAction);

  const invalidateInbox = (): Promise<void> => qc.invalidateQueries({ queryKey: queries.runs.lists() });

  const acceptM = useMutation({
    mutationFn: () => acceptRun(row.runId),
    onSuccess: () => {
      toast.success("Accepted — replayed onto your branch; tail staged to commit");
      setOpenAction(null);
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  const discardM = useMutation({
    mutationFn: () => discardRun(row.runId),
    onSuccess: () => {
      toast.success("Changes discarded");
      setOpenAction(null);
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  const busy = acceptM.isPending || discardM.isPending;

  function openDialog(kind: ActionKind): void {
    acceptM.reset();
    discardM.reset();
    setOpenAction(kind);
  }

  return (
    <div className="contents">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" disabled={busy} data-testid={`run-actions-trigger-${row.runId}`}>
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-testid={`run-action-accept-${row.runId}`} onSelect={() => openDialog("accept")}>
            <Check className="size-4" />
            Accept
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            data-testid={`run-action-discard-${row.runId}`}
            onSelect={() => openDialog("discard")}
          >
            <Trash2 className="size-4" />
            Discard
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {openAction !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid={`${openAction}-dialog`}>
          <div className="absolute inset-0 bg-[var(--sw-text)]/10" onClick={() => setOpenAction(null)} aria-hidden />
          <div className="relative z-10 flex w-full max-w-sm flex-col gap-4 rounded-[var(--sw-radius-card)] border border-[var(--sw-border)] bg-[var(--sw-surface)] p-6 text-[length:var(--sw-text-sm)]">
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-2 top-2"
              onClick={() => setOpenAction(null)}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>

            {openAction === "accept" && (
              <div className="flex flex-col gap-3" data-testid="accept-confirm">
                <p className="font-medium text-[length:var(--sw-text-md)]">Accept changes</p>
                <p className="text-[length:var(--sw-text-sm)] text-sw-muted">
                  Replays this run's commits onto your current branch and stages the uncommitted tail for you to commit.
                  A conflict leaves your branch untouched.
                </p>
                {acceptM.error && (
                  <p
                    className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
                    data-testid="worktree-action-error"
                  >
                    {errorMsg(acceptM.error)}
                  </p>
                )}
                <div className="flex justify-end gap-1 border-t border-[var(--sw-border)] pt-3">
                  <Button type="button" variant="ghost" size="xs" onClick={() => setOpenAction(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    disabled={acceptM.isPending}
                    onClick={() => acceptM.mutate()}
                    data-testid={`accept-confirm-btn-${row.runId}`}
                  >
                    Accept
                  </Button>
                </div>
              </div>
            )}

            {openAction === "discard" && (
              <div className="flex flex-col gap-3" data-testid="discard-confirm">
                <p className="font-medium text-[length:var(--sw-text-md)]">Discard changes</p>
                <p className="text-[length:var(--sw-text-sm)] text-sw-muted">
                  Permanently discard all changes for this run. This cannot be undone.
                </p>
                {discardM.error && (
                  <p
                    className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
                    data-testid="worktree-action-error"
                  >
                    {errorMsg(discardM.error)}
                  </p>
                )}
                <div className="flex justify-end gap-1 border-t border-[var(--sw-border)] pt-3">
                  <Button type="button" variant="ghost" size="xs" onClick={() => setOpenAction(null)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={discardM.isPending}
                    onClick={() => discardM.mutate()}
                    data-testid={`discard-confirm-btn-${row.runId}`}
                  >
                    Discard
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

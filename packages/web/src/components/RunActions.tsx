// RunActions — compact dropdown + confirm dialog for worktree inbox actions.
//
// Renders nothing unless inboxStatus === "pending". Two actions: Accept
// (replay the run's commits onto the operator's current branch + stage the
// uncommitted tail to commit) and Discard. Neither takes input — accept's
// target is the operator's current branch and the commit message is theirs.
//
// The confirm step is the AlertDialog primitive: it portals to document.body,
// traps focus, dismisses on Escape / overlay-click, and carries the
// `alertdialog` ARIA role — none of which we hand-roll. A refusal (e.g. an
// accept that doesn't merge cleanly) is shown inline and the dialog stays
// open, so the confirm button is a plain Button rather than AlertDialogAction
// (which would auto-close); the mutation's success handler does the closing.
//
// Two-component split: RunActions is the public guard (returns null when not
// pending); RunActionsInner holds all hooks so React Rules-of-Hooks are
// satisfied — hooks can never appear after an early return.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Trash2 } from "lucide-react";
import { useState } from "react";
import type { RunSummary } from "../lib/api.ts";
import { acceptRun, discardRun } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { extractErrorMessage, toast } from "../lib/toast.ts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
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

/** Test-only prop: seed the initially-open confirm dialog without going
 * through the dropdown. Read once into state — it does NOT track changes. */
export type RunActionsTestOpenAction = ActionKind | null;

function errorMsg(err: unknown): string {
  return extractErrorMessage(err, "Unknown error");
}

/** Public entry point. Returns null when `inboxStatus !== "pending"` so
 * callers can unconditionally mount it and it self-hides. The actual
 * hook-heavy logic lives in RunActionsInner to keep hooks unconditional. */
export function RunActions({
  row,
  _testInitialOpenAction,
}: {
  row: RunActionsRun;
  /** @internal test-only: bypass dropdown and open a dialog on mount. */
  _testInitialOpenAction?: RunActionsTestOpenAction;
}): JSX.Element | null {
  if (row.inboxStatus !== "pending") return null;
  return <RunActionsInner row={row} _testInitialOpenAction={_testInitialOpenAction ?? null} />;
}

function RunActionsInner({
  row,
  _testInitialOpenAction,
}: {
  row: RunActionsRun;
  _testInitialOpenAction: RunActionsTestOpenAction;
}): JSX.Element {
  const qc = useQueryClient();
  // _testInitialOpenAction seeds the initial state only (read once on mount).
  const [openAction, setOpenAction] = useState<ActionKind | null>(_testInitialOpenAction);

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

  // Escape / overlay-click / Cancel all route here via Radix's onOpenChange.
  const closeOnDismiss = (open: boolean): void => {
    if (!open) setOpenAction(null);
  };

  return (
    <>
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

      <ConfirmDialog
        open={openAction === "accept"}
        onOpenChange={closeOnDismiss}
        testId="accept-dialog"
        title="Accept changes"
        description="Replays this run's commits onto your current branch and stages the uncommitted tail for you to commit. A conflict leaves your branch untouched."
        confirmLabel="Accept"
        confirmTestId={`accept-confirm-btn-${row.runId}`}
        error={acceptM.error ? errorMsg(acceptM.error) : null}
        pending={acceptM.isPending}
        onConfirm={() => acceptM.mutate()}
      />
      <ConfirmDialog
        open={openAction === "discard"}
        onOpenChange={closeOnDismiss}
        testId="discard-dialog"
        title="Discard changes"
        description="Permanently discard all changes for this run. This cannot be undone."
        confirmLabel="Discard"
        confirmTestId={`discard-confirm-btn-${row.runId}`}
        destructive
        error={discardM.error ? errorMsg(discardM.error) : null}
        pending={discardM.isPending}
        onConfirm={() => discardM.mutate()}
      />
    </>
  );
}

/** Shared confirm shell for both inbox actions. The confirm button is a plain
 * Button (not AlertDialogAction) so a failed mutation keeps the dialog open to
 * show `error` inline; Cancel / Escape / overlay-click close via onOpenChange. */
function ConfirmDialog({
  open,
  onOpenChange,
  testId,
  title,
  description,
  confirmLabel,
  confirmTestId,
  destructive = false,
  error,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  title: string;
  description: string;
  confirmLabel: string;
  confirmTestId: string;
  destructive?: boolean;
  error: string | null;
  pending: boolean;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error !== null && (
          <p
            className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
            data-testid="worktree-action-error"
          >
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button type="button" variant="ghost" size="xs" disabled={pending} data-testid={`${testId}-cancel`}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="xs"
            disabled={pending}
            onClick={onConfirm}
            data-testid={confirmTestId}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

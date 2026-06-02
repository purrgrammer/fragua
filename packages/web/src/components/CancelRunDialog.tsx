import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

export interface CancelRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  error?: Error | null;
  onConfirm: (reason: string | undefined) => void;
  /** When false the reason textarea is hidden (e.g. paused-notice cancel path
   * where no reason field exists). Defaults to true. */
  showReason?: boolean;
}

export function CancelRunDialog({
  open,
  onOpenChange,
  isPending,
  error,
  onConfirm,
  showReason = true,
}: CancelRunDialogProps): JSX.Element {
  const [reason, setReason] = useState("");

  function handleConfirm(): void {
    const trimmed = reason.trim();
    onConfirm(trimmed.length > 0 ? trimmed : undefined);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) setReason("");
    onOpenChange(next);
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent data-testid="cancel-run-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel run?</AlertDialogTitle>
          <AlertDialogDescription>
            This action is terminal and irreversible. The run cannot be resumed after cancellation.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {showReason && (
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Optional reason"
            rows={2}
            disabled={isPending}
            data-testid="run-controls-cancel-reason"
            className="w-full resize-none rounded-sw-card border border-sw-border bg-sw-bg px-2 py-1 text-sw-xs text-sw-text placeholder:text-sw-muted focus:outline-none"
          />
        )}

        {error != null && (
          <p className="text-sw-xs text-sw-danger" data-testid="run-controls-error">
            {error.message}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="ghost" size="sm" disabled={isPending} data-testid="cancel-run-dialog-dismiss">
              Keep run
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant="destructive"
              size="sm"
              disabled={isPending}
              onClick={handleConfirm}
              data-testid="run-controls-cancel-confirm"
            >
              {isPending ? "Cancelling…" : "Cancel run"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

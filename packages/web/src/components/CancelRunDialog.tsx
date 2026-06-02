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
  onConfirm: (reason: string | undefined) => void;
  /** When false the reason textarea is hidden (e.g. paused-notice cancel path
   * where no reason field exists). Defaults to true. */
  showReason?: boolean;
}

// Confirming closes the dialog immediately (Radix `AlertDialogAction`) and fires
// the mutation; success/failure is reported by the caller's toast. We don't keep
// the dialog open to show a pending state — a cancel is a quick fire-and-forget.
export function CancelRunDialog({
  open,
  onOpenChange,
  onConfirm,
  showReason = true,
}: CancelRunDialogProps): JSX.Element {
  const [reason, setReason] = useState("");

  function handleConfirm(): void {
    const trimmed = reason.trim();
    onConfirm(trimmed.length > 0 ? trimmed : undefined);
    // Reset explicitly: the success path closes the dialog by flipping the
    // parent's `open` prop, which does NOT fire `onOpenChange`, so the dismiss
    // reset below wouldn't run and the reason would leak into the next open.
    setReason("");
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
            data-testid="run-controls-cancel-reason"
            className="w-full resize-none rounded-sw-card border border-sw-border bg-sw-bg px-2 py-1 text-sw-xs text-sw-text placeholder:text-sw-muted focus:outline-none"
          />
        )}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="ghost" size="sm" data-testid="cancel-run-dialog-dismiss">
              Keep run
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button variant="destructive" size="sm" onClick={handleConfirm} data-testid="run-controls-cancel-confirm">
              Cancel run
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

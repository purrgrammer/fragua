// RunActions — compact dropdown + per-action dialog for worktree inbox actions.
//
// Renders nothing unless inboxStatus === "pending". Contextual: Branch
// and Merge only appear when changeStat.committed is non-null (the run
// has committed history). Commit and Discard are always offered.
//
// The action forms are rendered inline (not portaled) so they are
// accessible to tests and to keyboard/focus management in the host tree.
//
// Two-component split: RunActions is the public guard (returns null when
// not pending); RunActionsInner holds all hooks so React Rules-of-Hooks
// are satisfied — hooks can never appear after an early return.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, GitMerge, MoreHorizontal, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { RunSummary } from "../lib/api.ts";
import { branchRun, commitRun, discardRun, mergeRun } from "../lib/api.ts";
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
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

type ActionKind = "branch" | "commit" | "merge" | "discard";

export type RunActionsRun = Pick<RunSummary, "runId" | "inboxStatus" | "changeStat" | "baseGitRef">;

/** Test-only prop: directly open one of the action forms without going
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
  const hasCommitted = row.changeStat?.committed != null;

  const [openAction, setOpenAction] = useState<ActionKind | null>(_testOpenAction);

  const invalidateInbox = (): Promise<void> => qc.invalidateQueries({ queryKey: queries.runs.lists() });

  // ── Branch ────────────────────────────────────────────────────────
  const [branchName, setBranchName] = useState("");
  const [branchForce, setBranchForce] = useState(false);
  const branchM = useMutation({
    mutationFn: () => branchRun(row.runId, { branch: branchName, force: branchForce }),
    onSuccess: () => {
      toast.success("Branch created");
      setOpenAction(null);
      setBranchName("");
      setBranchForce(false);
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  // ── Commit ────────────────────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState("");
  const [commitOnto, setCommitOnto] = useState(row.baseGitRef ?? "");
  const commitM = useMutation({
    mutationFn: () => commitRun(row.runId, { message: commitMsg, onto: commitOnto || undefined }),
    onSuccess: () => {
      toast.success("Changes committed");
      setOpenAction(null);
      setCommitMsg("");
      setCommitOnto(row.baseGitRef ?? "");
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  // ── Merge ─────────────────────────────────────────────────────────
  const [mergeMode, setMergeMode] = useState<"ff" | "no-ff" | "squash">("ff");
  const [mergeInto, setMergeInto] = useState(row.baseGitRef ?? "");
  const mergeM = useMutation({
    mutationFn: () => mergeRun(row.runId, { mode: mergeMode, into: mergeInto || undefined }),
    onSuccess: () => {
      const ref = mergeInto || row.baseGitRef || "target";
      toast.success(`Merged into ${ref}`);
      setOpenAction(null);
      setMergeInto(row.baseGitRef ?? "");
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  // ── Discard ───────────────────────────────────────────────────────
  const discardM = useMutation({
    mutationFn: () => discardRun(row.runId),
    onSuccess: () => {
      toast.success("Changes discarded");
      setOpenAction(null);
      return invalidateInbox();
    },
    onError: (err) => toast.error(errorMsg(err)),
  });

  const busy = branchM.isPending || commitM.isPending || mergeM.isPending || discardM.isPending;

  function openDialog(kind: ActionKind): void {
    branchM.reset();
    commitM.reset();
    mergeM.reset();
    discardM.reset();
    setOpenAction(kind);
  }

  return (
    <div className="contents">
      {/* ── Dropdown trigger ────────────────────────────────── */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            data-testid={`run-actions-trigger-${row.runId}`}
            aria-label="Actions"
          >
            <MoreHorizontal className="size-3" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hasCommitted && (
            <DropdownMenuItem data-testid={`run-action-branch-${row.runId}`} onSelect={() => openDialog("branch")}>
              <GitBranch className="size-4" />
              Branch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid={`run-action-commit-${row.runId}`} onSelect={() => openDialog("commit")}>
            <GitCommitHorizontal className="size-4" />
            Commit
          </DropdownMenuItem>
          {hasCommitted && (
            <DropdownMenuItem data-testid={`run-action-merge-${row.runId}`} onSelect={() => openDialog("merge")}>
              <GitMerge className="size-4" />
              Merge
            </DropdownMenuItem>
          )}
          {hasCommitted && <DropdownMenuSeparator />}
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

      {/* ── Inline action forms (no portal — accessible to tests and focus) */}
      {openAction !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" data-testid={`${openAction}-dialog`}>
          {/* Scrim */}
          <div className="absolute inset-0 bg-[var(--sw-text)]/10" onClick={() => setOpenAction(null)} aria-hidden />
          {/* Card */}
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

            {/* ── Branch form ───────────────────────────── */}
            {openAction === "branch" && (
              <form
                data-testid="branch-form"
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  branchM.mutate();
                }}
              >
                <p className="font-medium text-[length:var(--sw-text-md)]">Create branch</p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`branch-name-${row.runId}`} className="text-[length:var(--sw-text-xs)] text-sw-muted">
                    Branch name
                  </label>
                  <Input
                    id={`branch-name-${row.runId}`}
                    placeholder="branch name"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    disabled={branchM.isPending}
                    required
                    data-testid="branch-name-input"
                  />
                </div>
                <label className="flex items-center gap-2 text-[length:var(--sw-text-xs)] text-sw-muted">
                  <input
                    type="checkbox"
                    checked={branchForce}
                    onChange={(e) => setBranchForce(e.target.checked)}
                    disabled={branchM.isPending}
                    data-testid="branch-force-checkbox"
                  />
                  force
                </label>
                {branchM.error && (
                  <p
                    className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
                    data-testid="worktree-action-error"
                  >
                    {errorMsg(branchM.error)}
                  </p>
                )}
                <div className="flex justify-end gap-1 border-t border-[var(--sw-border)] pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setOpenAction(null)}
                    disabled={branchM.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="xs"
                    disabled={branchM.isPending || branchName.trim().length === 0}
                    data-testid="branch-submit-btn"
                  >
                    Create
                  </Button>
                </div>
              </form>
            )}

            {/* ── Commit form ───────────────────────────── */}
            {openAction === "commit" && (
              <form
                data-testid="commit-form"
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  commitM.mutate();
                }}
              >
                <p className="font-medium text-[length:var(--sw-text-md)]">Commit changes</p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`commit-msg-${row.runId}`} className="text-[length:var(--sw-text-xs)] text-sw-muted">
                    Commit message
                  </label>
                  <Input
                    id={`commit-msg-${row.runId}`}
                    placeholder="commit message (required)"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    disabled={commitM.isPending}
                    required
                    data-testid="commit-message-input"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`commit-onto-${row.runId}`} className="text-[length:var(--sw-text-xs)] text-sw-muted">
                    onto (branch / sha)
                  </label>
                  <Input
                    id={`commit-onto-${row.runId}`}
                    placeholder="onto (optional branch/sha)"
                    value={commitOnto}
                    onChange={(e) => setCommitOnto(e.target.value)}
                    disabled={commitM.isPending}
                    data-testid="commit-onto-input"
                  />
                </div>
                {commitM.error && (
                  <p
                    className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
                    data-testid="worktree-action-error"
                  >
                    {errorMsg(commitM.error)}
                  </p>
                )}
                <div className="flex justify-end gap-1 border-t border-[var(--sw-border)] pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setOpenAction(null)}
                    disabled={commitM.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="xs"
                    disabled={commitM.isPending || commitMsg.trim().length === 0}
                    data-testid="commit-submit-btn"
                  >
                    Commit
                  </Button>
                </div>
              </form>
            )}

            {/* ── Merge form ────────────────────────────── */}
            {openAction === "merge" && (
              <form
                data-testid="merge-form"
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  mergeM.mutate();
                }}
              >
                <p className="font-medium text-[length:var(--sw-text-md)]">Merge into branch</p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`merge-mode-${row.runId}`} className="text-[length:var(--sw-text-xs)] text-sw-muted">
                    Mode
                  </label>
                  <Select
                    value={mergeMode}
                    onValueChange={(v) => setMergeMode(v as "ff" | "no-ff" | "squash")}
                    disabled={mergeM.isPending}
                  >
                    <SelectTrigger id={`merge-mode-${row.runId}`} size="sm" data-testid="merge-mode-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ff">Fast-forward (ff)</SelectItem>
                      <SelectItem value="no-ff">No fast-forward (no-ff)</SelectItem>
                      <SelectItem value="squash">Squash</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`merge-into-${row.runId}`} className="text-[length:var(--sw-text-xs)] text-sw-muted">
                    into (target branch)
                  </label>
                  <Input
                    id={`merge-into-${row.runId}`}
                    placeholder="into (optional target branch)"
                    value={mergeInto}
                    onChange={(e) => setMergeInto(e.target.value)}
                    disabled={mergeM.isPending}
                    data-testid="merge-into-input"
                  />
                </div>
                {mergeM.error && (
                  <p
                    className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
                    data-testid="worktree-action-error"
                  >
                    {errorMsg(mergeM.error)}
                  </p>
                )}
                <div className="flex justify-end gap-1 border-t border-[var(--sw-border)] pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setOpenAction(null)}
                    disabled={mergeM.isPending}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="xs" disabled={mergeM.isPending} data-testid="merge-submit-btn">
                    Merge
                  </Button>
                </div>
              </form>
            )}

            {/* ── Discard confirm ──────────────────────── */}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setOpenAction(null)}
                    disabled={discardM.isPending}
                  >
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

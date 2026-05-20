// WorktreeInboxRow — one row in the "Recoverable work" inbox section.
//
// Shows: run title (link to detail), change-stat badge, terminal status
// badge, and four inline action triggers (Branch / Commit / Merge /
// Discard). Each trigger toggles a small inline form below the row.
//
// Mutation pattern mirrors RunControls.tsx: useMutation + onSuccess
// invalidates queries.runs.lists() so the acted/discarded row leaves
// the list.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal, GitMerge, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, branchRun, commitRun, discardRun, mergeRun, type RunSummary } from "../lib/api.ts";
import { summarizeChangeStat } from "../lib/changeStat.ts";
import { queries } from "../lib/queries.ts";
import { displayTitle } from "./RunRow.tsx";
import { RunStatusBadge } from "./RunStatusBadge.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

type ActionKind = "branch" | "commit" | "merge" | "discard";

export function WorktreeInboxRow({ row }: { row: RunSummary }): JSX.Element {
  const qc = useQueryClient();

  const [openAction, setOpenAction] = useState<ActionKind | null>(null);

  // ── Branch form state ─────────────────────────────────────────────
  const [branchName, setBranchName] = useState("");
  const [branchForce, setBranchForce] = useState(false);

  // ── Commit form state ─────────────────────────────────────────────
  const [commitMsg, setCommitMsg] = useState("");
  const [commitOnto, setCommitOnto] = useState("");

  // ── Merge form state ──────────────────────────────────────────────
  const [mergeMode, setMergeMode] = useState<"ff" | "no-ff" | "squash">("ff");
  const [mergeInto, setMergeInto] = useState("");

  // ── Shared invalidation ───────────────────────────────────────────
  const invalidateInbox = (): Promise<void> => qc.invalidateQueries({ queryKey: queries.runs.lists() });

  // ── Mutations ─────────────────────────────────────────────────────
  const branchM = useMutation({
    mutationFn: () => branchRun(row.runId, { branch: branchName, force: branchForce }),
    onSuccess: () => {
      setOpenAction(null);
      setBranchName("");
      setBranchForce(false);
      return invalidateInbox();
    },
  });

  const commitM = useMutation({
    mutationFn: () => commitRun(row.runId, { message: commitMsg, onto: commitOnto || undefined }),
    onSuccess: () => {
      setOpenAction(null);
      setCommitMsg("");
      setCommitOnto("");
      return invalidateInbox();
    },
  });

  const mergeM = useMutation({
    mutationFn: () => mergeRun(row.runId, { mode: mergeMode, into: mergeInto || undefined }),
    onSuccess: () => {
      setOpenAction(null);
      setMergeInto("");
      return invalidateInbox();
    },
  });

  const discardM = useMutation({
    mutationFn: () => discardRun(row.runId),
    onSuccess: () => {
      setOpenAction(null);
      return invalidateInbox();
    },
  });

  // ── Change-stat badge ─────────────────────────────────────────────
  const stat = summarizeChangeStat(row.changeStat);

  // ── Error helpers ─────────────────────────────────────────────────
  function errorMsg(err: unknown): string {
    if (err instanceof ApiError) return err.body?.error ?? err.message;
    if (err instanceof Error) return err.message;
    return "Unknown error";
  }

  const activeM =
    openAction === "branch"
      ? branchM
      : openAction === "commit"
        ? commitM
        : openAction === "merge"
          ? mergeM
          : openAction === "discard"
            ? discardM
            : null;

  const busy = branchM.isPending || commitM.isPending || mergeM.isPending || discardM.isPending;

  function toggleAction(kind: ActionKind): void {
    setOpenAction((prev) => (prev === kind ? null : kind));
  }

  return (
    <li
      data-testid={`worktree-inbox-row-${row.runId}`}
      className="flex w-full min-w-0 flex-col gap-2 rounded-sw-card border border-sw-border bg-sw-surface px-3 py-2"
    >
      {/* ── Primary row ──────────────────────────────────────────── */}
      <div className="flex w-full min-w-0 items-center gap-2">
        {/* Title — links to run detail */}
        <Link
          to={`/runs/${row.runId}`}
          className="min-w-0 flex-1 truncate text-sw-sm font-medium text-sw-text hover:underline"
          title={row.runId}
        >
          {displayTitle(row)}
        </Link>

        {/* Change-stat badge */}
        {stat && (
          <Badge
            variant="muted"
            className="shrink-0 font-mono tabular-nums"
            data-testid={`worktree-inbox-stat-${row.runId}`}
          >
            {stat.filesChanged} {stat.filesChanged === 1 ? "file" : "files"},{" "}
            <span className="text-[var(--sw-accent-success)]">+{stat.insertions}</span>
            {" / "}
            <span className="text-[var(--sw-accent-error)]">−{stat.deletions}</span>
          </Badge>
        )}

        {/* Terminal status */}
        <RunStatusBadge status={row.status} runStatus={row.runStatus} />

        {/* ── Action buttons ───────────────────────────────────── */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            title="Branch"
            data-testid={`worktree-branch-btn-${row.runId}`}
            onClick={() => toggleAction("branch")}
            aria-expanded={openAction === "branch"}
          >
            <GitBranch className="size-3" />
            Branch
          </Button>

          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            title="Commit"
            data-testid={`worktree-commit-btn-${row.runId}`}
            onClick={() => toggleAction("commit")}
            aria-expanded={openAction === "commit"}
          >
            <GitCommitHorizontal className="size-3" />
            Commit
          </Button>

          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            title="Merge"
            data-testid={`worktree-merge-btn-${row.runId}`}
            onClick={() => toggleAction("merge")}
            aria-expanded={openAction === "merge"}
          >
            <GitMerge className="size-3" />
            Merge
          </Button>

          <Button
            variant="destructive"
            size="xs"
            disabled={busy}
            title="Discard"
            data-testid={`worktree-discard-btn-${row.runId}`}
            onClick={() => toggleAction("discard")}
            aria-expanded={openAction === "discard"}
          >
            <Trash2 className="size-3" />
            Discard
          </Button>
        </div>
      </div>

      {/* ── Inline action forms ───────────────────────────────────── */}

      {/* Branch form */}
      {openAction === "branch" && (
        <form
          className="flex flex-col gap-2 border-t border-sw-border pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            branchM.mutate();
          }}
          data-testid="branch-form"
        >
          <p className="text-[length:var(--sw-text-xs)] font-medium text-sw-text">Create branch</p>
          <Input
            placeholder="branch name"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            disabled={branchM.isPending}
            required
            data-testid="branch-name-input"
          />
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
          <div className="flex justify-end gap-1">
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

      {/* Commit form */}
      {openAction === "commit" && (
        <form
          className="flex flex-col gap-2 border-t border-sw-border pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            commitM.mutate();
          }}
          data-testid="commit-form"
        >
          <p className="text-[length:var(--sw-text-xs)] font-medium text-sw-text">Commit changes</p>
          <Input
            placeholder="commit message (required)"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            disabled={commitM.isPending}
            required
            data-testid="commit-message-input"
          />
          <Input
            placeholder="onto (optional branch/sha)"
            value={commitOnto}
            onChange={(e) => setCommitOnto(e.target.value)}
            disabled={commitM.isPending}
            data-testid="commit-onto-input"
          />
          {commitM.error && (
            <p
              className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
              data-testid="worktree-action-error"
            >
              {errorMsg(commitM.error)}
            </p>
          )}
          <div className="flex justify-end gap-1">
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

      {/* Merge form */}
      {openAction === "merge" && (
        <form
          className="flex flex-col gap-2 border-t border-sw-border pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            mergeM.mutate();
          }}
          data-testid="merge-form"
        >
          <p className="text-[length:var(--sw-text-xs)] font-medium text-sw-text">Merge into branch</p>
          <Select
            value={mergeMode}
            onValueChange={(v) => setMergeMode(v as "ff" | "no-ff" | "squash")}
            disabled={mergeM.isPending}
          >
            <SelectTrigger size="sm" data-testid="merge-mode-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ff">Fast-forward (ff)</SelectItem>
              <SelectItem value="no-ff">No fast-forward (no-ff)</SelectItem>
              <SelectItem value="squash">Squash</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder="into (optional target branch)"
            value={mergeInto}
            onChange={(e) => setMergeInto(e.target.value)}
            disabled={mergeM.isPending}
            data-testid="merge-into-input"
          />
          {mergeM.error && (
            <p
              className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
              data-testid="worktree-action-error"
            >
              {errorMsg(mergeM.error)}
            </p>
          )}
          <div className="flex justify-end gap-1">
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

      {/* Discard confirmation */}
      {openAction === "discard" && (
        <div className="flex flex-col gap-2 border-t border-sw-border pt-2" data-testid="discard-confirm">
          <p className="text-[length:var(--sw-text-xs)] text-sw-muted">
            Permanently discard all uncommitted changes for{" "}
            <span className="font-medium text-sw-text">{displayTitle(row)}</span>? This cannot be undone.
          </p>
          {discardM.error && (
            <p
              className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]"
              data-testid="worktree-action-error"
            >
              {errorMsg(discardM.error)}
            </p>
          )}
          <div className="flex justify-end gap-1">
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

      {/* Shared error for active mutation (shown when form is closed) */}
      {activeM?.error && openAction === null && (
        <p className="text-[length:var(--sw-text-xs)] text-[var(--sw-accent-error)]" data-testid="worktree-row-error">
          {errorMsg(activeM.error)}
        </p>
      )}
    </li>
  );
}

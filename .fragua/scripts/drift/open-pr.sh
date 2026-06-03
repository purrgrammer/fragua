#!/usr/bin/env bash
# open-pr.sh — commit drift's doc edits and open a PR on a fresh per-run branch.
#
# Called by .fragua/workflows/drift.yaml's `open_pr` tool step, in the run's
# worktree — which shares the checkout's .git (remotes + the push credential),
# so a branch pushed here reaches origin.
#
# Opens a PR ONLY when there are tracked doc edits. The decision keys off the
# real git tree, not the model's count: a clean tree — no auto-fixable findings,
# or only `## Manual` ones (which produce zero doc edits) — is a no-op, never an
# empty PR.
#
# Each run uses a fresh dated branch (`fragua/drift-YYYYMMDD`) and a PLAIN push —
# never `-f`. A fixed, force-pushed branch would silently clobber any human fixup
# commits pushed onto the drift PR between runs (the `## Manual` follow-ups the PR
# itself invites). A per-run branch shares nothing, so there is nothing to
# overwrite — each weekly PR is an independent snapshot. The run is idempotent on
# PR existence: a branch whose PR is already open no-ops; a branch a prior run
# pushed but never opened a PR for (e.g. a transient gh failure) gets its PR
# opened on retry. Commits are attributed to the GitHub Actions bot.
#
#   bash open-pr.sh <open_pr:true|false>

set -euo pipefail

open_pr="${1:-true}"
branch="fragua/drift-$(date -u +%Y%m%d)"
title="[docs] drift: doc/code sync ($(date -u +%Y-%m-%d))"
body="drift-pr.md"

if [ "$open_pr" != "true" ]; then
  echo "open_pr=false — doc edits left in the worktree, no PR opened"
  exit 0
fi

# Stage ONLY tracked markdown doc edits. Scoping to *.md keeps any unrelated
# tracked change that surfaces in the worktree (e.g. a file-mode flip under
# core.fileMode) out of the PR; `-u` never stages the untracked drift-pr.md.
git add -u -- '*.md'

# Nothing staged ⇒ no doc edits (only Manual findings, or no drift) ⇒ no PR.
if git diff --cached --quiet; then
  echo "no doc edits — no PR opened"
  exit 0
fi

# Idempotent on PR existence, not branch existence: a prior run that pushed the
# branch but failed before opening the PR (e.g. a transient `gh` error) leaves
# the branch upstream with no PR — a retry should OPEN the PR, not skip.
existing_pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$existing_pr" ]; then
  echo "PR #$existing_pr already open for $branch — nothing to do"
  exit 0
fi

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  # Branch already upstream from a prior run that never opened a PR — open the PR
  # for the existing remote head rather than re-pushing (a fresh commit off main
  # would be non-fast-forward, and we never force).
  echo "$branch already upstream with no open PR — opening the PR for it"
else
  # Commit as the GitHub Actions bot — a system identity with no real account.
  # A bare `<name>@users.noreply.github.com` would attribute commits to whatever
  # GitHub user is named `<name>`; 41898282 is github-actions[bot]'s user id.
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git checkout -B "$branch"
  git commit -m "[docs] drift: sync docs to the code they describe"
  git push -u origin "$branch" # plain push of a fresh branch — never -f
fi

# apply writes the body; fall back to a minimal one if that step was skipped.
if [ ! -f "$body" ]; then
  printf '## Doc drift — auto-sync\n\nAutomated doc/code sync. Review the diff.\n' >"$body"
fi

gh pr create --base main --head "$branch" --title "$title" --body-file "$body"
echo "opened PR for $branch"

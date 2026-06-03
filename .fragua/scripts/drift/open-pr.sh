#!/usr/bin/env bash
# open-pr.sh — commit drift's doc edits and open/update a PR.
#
# Called by .fragua/workflows/drift.yaml's `open_pr` tool step, in the run's
# worktree — which shares the checkout's .git (remotes + the push credential),
# so a branch pushed here reaches origin.
#
# Opens a PR ONLY when there are tracked doc edits. The decision keys off the
# real git tree, not the model's count: a clean tree — no auto-fixable findings,
# or only `## Manual` ones (which produce zero doc edits) — is a no-op, never an
# empty PR. Idempotent: a fixed branch, force-pushed from HEAD each run, updates
# the open PR rather than stacking duplicates.
#
#   bash open-pr.sh <open_pr:true|false>

set -euo pipefail

open_pr="${1:-true}"
branch="fragua/drift"
title="[docs] drift: doc/code sync"
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

git config user.name "fragua-drift"
git config user.email "drift@users.noreply.github.com"
git checkout -B "$branch"
git commit -m "[docs] drift: sync docs to the code they describe"
git push -f -u origin "$branch"

# apply writes the body; fall back to a minimal one if that step was skipped.
if [ ! -f "$body" ]; then
  printf '## Doc drift — auto-sync\n\nAutomated doc/code sync. Review the diff.\n' >"$body"
fi

pr="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$pr" ]; then
  gh pr edit "$pr" --title "$title" --body-file "$body"
  echo "updated PR #$pr"
else
  gh pr create --base main --head "$branch" --title "$title" --body-file "$body"
fi

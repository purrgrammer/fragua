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
# overwrite — each weekly PR is an independent snapshot. If today's branch already
# exists upstream (a same-day re-run), its PR is open already and the run no-ops.
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

# Today's branch already upstream ⇒ a same-day run already opened its PR. No-op
# rather than racing a second push — and we never force over it.
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "$branch already exists upstream — today's PR is open; skipping"
  exit 0
fi

git config user.name "fragua-drift"
git config user.email "drift@users.noreply.github.com"
git checkout -B "$branch"
git commit -m "[docs] drift: sync docs to the code they describe"
git push -u origin "$branch" # plain push of a fresh branch — never -f

# apply writes the body; fall back to a minimal one if that step was skipped.
if [ ! -f "$body" ]; then
  printf '## Doc drift — auto-sync\n\nAutomated doc/code sync. Review the diff.\n' >"$body"
fi

gh pr create --base main --head "$branch" --title "$title" --body-file "$body"
echo "opened PR for $branch"

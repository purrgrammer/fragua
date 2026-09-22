#!/usr/bin/env bash
# resolve-pr.sh — turn a PR number into the review context `resolve` emits.
#
# Called by .fragua/workflows/review.yaml's `resolve` step, in the run's
# worktree. Prints one JSON object: {pr, state, diff_spec, paths}.
#
# The diff of a PR is what its head added over the point it forked from its
# base — for an OPEN PR that is `merge-base(base, head)..head`, and the step
# used to write `origin/main..HEAD` for it. For a MERGED PR that spec is
# inverted: `origin/main` has moved past the merge, so `origin/main..HEAD`
# shows everything landed since, backwards. GitHub keeps the PR head under
# `refs/pull/<n>/head` after the branch is deleted, and the merge commit's
# first parent is the base as it stood at merge time, so
# `merge-base(mergeCommit^1, head)..head` is the PR's own change under every
# merge strategy: for squash and merge commits the first parent IS the
# pre-merge base; for a rebase merge the head's original commits share no
# sha with the rebased ones, so the merge-base is still the fork point.
# Verified against squash-merged PRs here: matches `gh pr diff` file for file.
#
# The worktree ends on the reviewed code: an open PR is checked out (gh);
# a merged PR is a detached checkout of its merge commit, so lens reads see
# the files as they landed.
#
#   bash resolve-pr.sh <pr-number>

set -euo pipefail

n="${1:?pr number}"
case "$n" in ''|*[!0-9]*) echo "not a PR number: $n" >&2; exit 2;; esac

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree dirty" >&2
  exit 3
fi

read -r state merge_commit head_oid base_ref <<<"$(gh pr view "$n" --json state,mergeCommit,headRefOid,baseRefName \
  -q '[.state, (.mergeCommit.oid // "-"), .headRefOid, .baseRefName] | @tsv')"
if [ -z "${state:-}" ] || [ -z "${head_oid:-}" ]; then
  echo "gh could not resolve PR $n" >&2
  exit 4
fi

if [ "$state" = "MERGED" ]; then
  # The PR head survives branch deletion under refs/pull/<n>/head; the merge
  # commit is on the base branch.
  git fetch -q origin "refs/pull/$n/head" "$base_ref"
  if [ "$merge_commit" = "-" ]; then
    # Rebase-merged PRs have NO merge commit — GitHub reports `mergeCommit`
    # null, which the query above turns into "-". There is nothing to check out
    # and no `^1` to diff from, so `rev-parse -q --verify -^{commit}` used to
    # fail and abort the whole review with exit 5. The head still exists under
    # refs/pull/<n>/head; diff it against where it forked from the base.
    base="$(git merge-base "origin/$base_ref" "$head_oid")"
    git checkout -q --detach "$head_oid"
  else
    git rev-parse -q --verify "${merge_commit}^{commit}" >/dev/null || { echo "merge commit $merge_commit not reachable" >&2; exit 5; }
    base="$(git merge-base "${merge_commit}^1" "$head_oid")"
    git checkout -q --detach "$merge_commit"
  fi
  diff_spec="${base}..${head_oid}"
else
  gh pr checkout "$n" >/dev/null
  git fetch -q origin "$base_ref"
  base="$(git merge-base "origin/$base_ref" HEAD)"
  diff_spec="${base}..HEAD"
fi

paths="$(git diff --name-only "$diff_spec" | jq -R . | jq -sc .)"
jq -nc --arg pr "$n" --arg state "$state" --arg diff_spec "$diff_spec" --argjson paths "$paths" \
  '{pr: $pr, state: $state, diff_spec: $diff_spec, paths: $paths}'

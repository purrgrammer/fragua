#!/usr/bin/env bash
# post-review.sh — post review.md to a PR and emit what happened.
#
# Called by review.yaml's `post` step. This was two `llm` steps (haiku,
# [read, bash]) — `pr_approve` and `pr_feedback` — whose whole job was to
# branch on "is there a PR", pick one of two `gh` invocations, and retype the
# result as prose. The branch is a string compare and the severity check is a
# grep, so neither needed a model; pr_review.yaml already states the principle
# for its own verdict step: grep's exit code IS the routing decision.
#
# Folding them into one node also fixes a smaller thing. As two nodes, only one
# ran per review, so the run's typed result could bind only one of them and an
# approval reported nothing. One producer, one binding. The human gate loses
# its "approve despite findings" route, which was contradictory anyway —
# `--approve` on a review carrying High defects — and a human who wants that
# can still do it by hand.
#
# Writes one JSON object to $FRAGUA_OUTPUT: {posted, verdict, url}.
#   posted  — "approve" | "changes" | "comment" | "none"  (what reached GitHub)
#   verdict — "approve" | "blocking" | "non-blocking" | "local"
#   url     — the PR url, or "" when nothing was posted
#
#   bash post-review.sh <pr-number|none>

set -euo pipefail

: "${FRAGUA_OUTPUT:?post-review.sh must run in a tool step declaring outputs:}"

pr="${1:?pr number or 'none'}"
body=review.md

emit() { jq -nc --arg posted "$1" --arg verdict "$2" --arg url "$3" \
  '{posted: $posted, verdict: $verdict, url: $url}' > "$FRAGUA_OUTPUT"; }

# No PR to post to: a local diff review is a complete outcome, not a failure.
# Emit the shape downstream expects and stop — the review still exists on disk.
if [ "$pr" = none ] || [ -z "$pr" ]; then
  emit none local ""
  echo "no PR to post to — review kept local in $body"
  exit 0
fi

case "$pr" in *[!0-9]*) echo "not a PR number: $pr" >&2; exit 2;; esac
[ -s "$body" ] || { echo "$body is missing or empty — nothing to post" >&2; exit 3; }

url="$(gh pr view "$pr" --json url --jq .url)"

# Severity picks the verb, three ways. `synthesize` writes severities as
# `### Critical` / `### High` under `## Defects` — h3, not the h2 pr_review.yaml
# greps for — and emits `## All clear` when nothing survived its filters.
# Improvements alone never block.
if grep -qE '^### (Critical|High)[[:space:]]*$' "$body"; then
  gh pr review "$pr" --request-changes --body-file "$body"
  emit changes blocking "$url"
  echo "requested changes on PR #$pr"
elif grep -qE '^## (Defects|Improvements)[[:space:]]*$' "$body"; then
  gh pr review "$pr" --comment --body-file "$body"
  emit comment non-blocking "$url"
  echo "commented on PR #$pr"
else
  # Nothing to raise at all: a comment would leave the PR unapproved on a
  # review that found nothing. Approve it.
  gh pr review "$pr" --approve --body-file "$body"
  emit approve approve "$url"
  echo "approved PR #$pr"
fi

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
#   verdict — "approve" | "blocking" | "non-blocking" | "unreadable" | "local"
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

# Severity picks the verb — and the default is the SAFE one, not the convenient
# one. Approval requires a positive `## All clear` sentinel; anything this
# script does not recognise requests changes. That ordering matters more than
# the patterns: an approve-by-default chain turns every unrecognised body — a
# new template, a truncated write, a lens that crashed mid-file — into a silent
# approval. It already did once, for a `review_quick` review carrying a
# Critical finding, which is why both shapes are spelled out below.
#
#   `synthesize` (full)    → `### Critical` / `### High` under `## Defects`
#   `review_quick` (quick) → `- [critical] path:line` under `## Findings`
#   both, when clean       → `## All clear`
blocking='^###[[:space:]]*(critical|high)[[:space:]]*$|^-[[:space:]]*\[(critical|high)\]'
raised='^##[[:space:]]*(defects|improvements|findings)[[:space:]]*$'
clean='^##[[:space:]]*all clear[[:space:]]*$'

if grep -qiE "$blocking" "$body"; then
  verb=--request-changes; posted=changes; verdict=blocking
elif grep -qiE "$raised" "$body"; then
  verb=--comment; posted=comment; verdict=non-blocking
elif grep -qiE "$clean" "$body"; then
  verb=--approve; posted=approve; verdict=approve
else
  # Unrecognised shape. Do not approve something we could not read.
  verb=--request-changes; posted=changes; verdict=unreadable
  echo "post-review: $body matches no known review shape — requesting changes rather than approving" >&2
fi

gh pr review "$pr" "$verb" --body-file "$body"
emit "$posted" "$verdict" "$url"
echo "posted $verb on PR #$pr"

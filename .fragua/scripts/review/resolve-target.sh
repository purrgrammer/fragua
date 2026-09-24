#!/usr/bin/env bash
# resolve-target.sh — turn review.yaml's free-form `target` into the typed
# review context, deterministically. Writes one JSON object to $FRAGUA_OUTPUT:
# {pr, diff_spec, paths}.
#
# This used to be an `llm` step whose whole job was to classify the target,
# shell out to resolve-pr.sh, and copy the result into `emit_output`. Every
# branch of it is mechanism, so it costs a model turn for nothing — and, worse,
# it put model-authored text into a `diff_spec` that downstream steps interpolate
# into `git diff`. That forced a charset guard in the prompt and a containment
# pass over model-authored `paths`. A tool computes both, so neither defense is
# needed: the only untrusted string left is the operator's own `target`.
#
# Classification, first match wins — no judgment, so the order IS the contract:
#   1. empty                 → nothing to review (exit 1)
#   2. "PR <n>" / "#<n>" / bare digits → PR       (resolve-pr.sh)
#   3. an existing path or glob        → FILES    (diff_spec "", paths listed)
#   4. a resolvable commit-ish / range → DIFF
#   5. a branch on origin              → DIFF against its merge-base
#   6. otherwise             → cannot resolve (exit 2)
#
#   bash resolve-target.sh "<target>"

set -euo pipefail

: "${FRAGUA_OUTPUT:?resolve-target.sh must run in a tool step declaring outputs:}"

raw="${1-}"
# Trim surrounding whitespace; everything below matches on the trimmed form.
target="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

emit() { # emit <pr> <diff_spec> <paths-json>
  jq -nc --arg pr "$1" --arg diff_spec "$2" --argjson paths "$3" \
    '{pr: $pr, diff_spec: $diff_spec, paths: $paths}' > "$FRAGUA_OUTPUT"
}

paths_of() { git diff --name-only --end-of-options "$1" | jq -R . | jq -sc .; }

if [ -z "$target" ]; then
  echo "nothing to review: target is empty" >&2
  exit 1
fi

# ── 2. PR ────────────────────────────────────────────────────────────────
case "$target" in
  [Pp][Rr]\ *|\#*|*[!0-9]*) ;;            # fall through unless bare digits
  *) target="PR $target" ;;               # a bare number IS a PR
esac
case "$target" in
  [Pp][Rr]\ *|\#*)
    n="${target##*[!0-9]}"
    case "$n" in ''|*[!0-9]*) echo "not a PR number: $target" >&2; exit 2;; esac
    # resolve-pr.sh checks out the PR and prints {pr,state,diff_spec,paths};
    # `state` is not declared on the step, and the outputs schema is
    # additionalProperties:false, so project down to the declared keys.
    bash "$(dirname "$0")/resolve-pr.sh" "$n" \
      | jq -c '{pr, diff_spec, paths}' > "$FRAGUA_OUTPUT"
    exit 0
    ;;
esac

# ── 3. FILES ─────────────────────────────────────────────────────────────
# Existing paths (or a glob that matches some) are reviewed as they stand:
# no diff, the lenses read the files. Word-split deliberately so a
# space-separated list of paths works.
# shellcheck disable=SC2086
set -- $target
if [ "$#" -gt 0 ] && [ -e "$1" ]; then
  listed=""
  for p in "$@"; do
    [ -e "$p" ] || { echo "no such path: $p" >&2; exit 2; }
    listed="$listed$p
"
  done
  emit none "" "$(printf '%s' "$listed" | jq -R . | jq -sc 'map(select(. != ""))')"
  exit 0
fi

# ── 4. DIFF (commit-ish or range) ────────────────────────────────────────
# `rev-parse --verify` wants exactly one object, so a range has to be split and
# each endpoint verified on its own. `A...B` (symmetric) is accepted too; git
# diff understands both, and an empty endpoint (`..HEAD`, `HEAD..`) defaults to
# HEAD exactly as git does.
case "$target" in
  *...*) lhs="${target%%...*}"; rhs="${target##*...}"; is_range=1 ;;
  *..*)  lhs="${target%%..*}";  rhs="${target##*..}";  is_range=1 ;;
  *)     is_range=0 ;;
esac
if [ "$is_range" = 1 ]; then
  for side in "${lhs:-HEAD}" "${rhs:-HEAD}"; do
    git rev-parse -q --verify "${side}^{commit}" >/dev/null 2>&1 \
      || { echo "cannot resolve range endpoint: $side (in $target)" >&2; exit 2; }
  done
  emit none "$target" "$(paths_of "$target")"
  exit 0
fi
if git rev-parse -q --verify "${target}^{commit}" >/dev/null 2>&1; then
  emit none "$target" "$(paths_of "$target")"
  exit 0
fi

# ── 5. branch on origin ──────────────────────────────────────────────────
if git rev-parse -q --verify "origin/${target}^{commit}" >/dev/null 2>&1; then
  base="$(git merge-base "origin/$target" HEAD)"
  spec="${base}..origin/${target}"
  emit none "$spec" "$(paths_of "$spec")"
  exit 0
fi

echo "cannot resolve target: $target" >&2
exit 2

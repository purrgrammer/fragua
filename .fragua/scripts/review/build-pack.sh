#!/usr/bin/env bash
# build-pack.sh — materialise everything a review lens needs, once, up front.
#
# Called by `.fragua/workflows/pr_review.yaml`'s `prep_pack` step, in the run's
# worktree. Writes a `pack/` directory the lenses read INSTEAD of roaming the
# repo with read/grep/find.
#
# Why this exists: a lens that is free to explore spends its whole budget in a
# serial tool-call loop — one measured review ran 223 tool calls over 22 minutes
# of fan-out, 92% of the job's wall clock, with a single lens taking 17.5m on
# its own. None of that reading is parallel; each call is a round trip. Doing
# the reading once, deterministically, in ~20s of shell turns that loop into a
# handful of reads of files that are already on disk.
#
#   pack/INDEX.md          what is in the pack, and the change at a glance
#   pack/context.patch     the diff with 40 lines of context (the enclosing fn)
#   pack/files/<path>      post-image of each changed file (caps below)
#   pack/removed.txt       deleted lines, grouped by file
#   pack/callers.txt       references to changed symbols from OUTSIDE the diff
#   pack/risk-surface.txt  hunks touching auth/exec/sql/crypto/secrets/net, or NONE
#
# Two entry forms, so `pr_review` (a PR number) and `review` (any resolved diff
# spec — a range, a sha, or `HEAD` for uncommitted work) share one builder:
#
#   bash .fragua/scripts/review/build-pack.sh pr   <pr-number>
#   bash .fragua/scripts/review/build-pack.sh spec  <diff-spec>
#   bash .fragua/scripts/review/build-pack.sh files <path-list-file>

set -euo pipefail

MAX_FILES=40
MAX_FILE_LINES=1500
MAX_CALLER_LINES=200
MAX_PATCH_LINES=3000

mode="${1:?usage: build-pack.sh pr <n> | spec <diff-spec>}"
arg="${2:?usage: build-pack.sh pr <n> | spec <diff-spec>}"

out=pack
rm -rf "$out"
mkdir -p "$out/files"

case "$mode" in
  pr)
    case "$arg" in ''|*[!0-9]*) echo "not a PR number: $arg" >&2; exit 2;; esac
    # Resolve the PR's own change from refs, not from the checkout: a
    # `pull_request` build checks out the MERGE commit, whose `HEAD` diff
    # against the base includes whatever landed on the base since the PR forked.
    # `refs/pull/<n>/head` is the PR head itself and survives branch deletion;
    # merge-base against the base branch is the fork point. Fetched into private
    # refs so nothing collides with the checkout's own.
    read -r base_ref head_oid <<<"$(gh pr view "$arg" --json baseRefName,headRefOid -q '[.baseRefName, .headRefOid] | @tsv')"
    if [ -z "${base_ref:-}" ] || [ -z "${head_oid:-}" ]; then
      echo "gh could not resolve PR $arg" >&2
      exit 3
    fi
    git fetch -q --no-tags origin \
      "+refs/pull/$arg/head:refs/fragua/pr-head" \
      "+refs/heads/$base_ref:refs/fragua/pr-base"
    head="$(git rev-parse refs/fragua/pr-head)"
    base="$(git merge-base refs/fragua/pr-base "$head")"
    spec="$base..$head"
    label="PR #$arg (base \`$base_ref\`)"
    ;;
  spec)
    # Charset guard: the spec reaches `git diff` as an argument, and in `review`
    # it originates from an LLM step. Refuse anything that is not a bare
    # ref/range/sha, and never a leading `-` (option injection).
    case "$arg" in
      -*) echo "refusing a diff spec that starts with '-': $arg" >&2; exit 2;;
      *[!A-Za-z0-9._~^:/@-]*) echo "unsafe diff spec: $arg" >&2; exit 2;;
    esac
    spec="$arg"
    # The post-image lives at the right-hand side of a range; for a bare ref
    # like `HEAD` the change is uncommitted, so the working tree IS the
    # post-image and there is nothing to `git show`.
    case "$spec" in
      *..*) head="${spec##*..}"; [ -n "$head" ] || head=HEAD ;;
      *)    head="" ;;
    esac
    label="\`$spec\`"
    ;;
  files)
    # FILES mode: there is no diff — the review target IS a set of paths. A
    # `spec` of `HEAD` on a clean tree produces an empty diff and an empty
    # pack, which used to silently route a legitimate path review straight to
    # the human gate with zero lens output. Instead, synthesize a pseudo-diff
    # in which every line of every named file is an added line, so the whole
    # pipeline below works unchanged.
    #
    # `arg` is a file of newline-separated paths, and in `review` those paths
    # come from an LLM step — so contain each one under the worktree before
    # reading it. `--` stops flag injection but not traversal; resolve the
    # dirname AND the leaf (a symlink leaf still sits under the root) and
    # refuse anything that escapes. Fail closed.
    [ -r "$arg" ] || { echo "not a readable path list: $arg" >&2; exit 2; }
    root="$(pwd -P)"
    : > "$out/.pseudo.diff"
    kept_paths=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      d="$(dirname -- "$f")"
      b="$(basename -- "$f")"
      rd="$(cd "$d" 2>/dev/null && pwd -P)" || { echo "refusing unreadable path: $f" >&2; exit 2; }
      case "$rd/$b" in "$root"/*) : ;; *) echo "refusing path outside the worktree: $f" >&2; exit 2 ;; esac
      if [ -L "$rd/$b" ]; then
        real="$(readlink -f -- "$rd/$b" 2>/dev/null)" || real=""
        case "${real:-/nonexistent}" in "$root"/*) : ;; *) echo "refusing symlink leaving the worktree: $f" >&2; exit 2 ;; esac
      fi
      [ -f "$f" ] || continue
      printf '+++ b/%s\n' "$f" >> "$out/.pseudo.diff"
      sed 's/^/+/' < "$f" >> "$out/.pseudo.diff"
      kept_paths=$((kept_paths + 1))
    done < "$arg"
    [ "$kept_paths" -gt 0 ] || { echo "no readable files in $arg" >&2; exit 4; }
    spec=""
    head=""
    label="$kept_paths file(s)"
    ;;
  *)
    echo "usage: build-pack.sh pr <n> | spec <diff-spec> | files <path-list-file>" >&2
    exit 2
    ;;
esac

# One reader for the change, whatever produced it: a real `git diff` for the
# `pr` / `spec` forms, the pseudo-diff for `files`. Everything below consumes
# this and nothing below knows which mode it is in.
pseudo_diff() {
  case "${1:-}" in
    --numstat)
      awk '/^\+\+\+ b\//{if(f!="")print n"\t0\t"f; f=substr($0,7); n=0; next} /^\+[^+]/{n++} END{if(f!="")print n"\t0\t"f}' "$out/.pseudo.diff"
      ;;
    --name-only)
      awk '/^\+\+\+ b\//{print substr($0,7)}' "$out/.pseudo.diff"
      ;;
    --name-status)
      awk '/^\+\+\+ b\//{print "A\t" substr($0,7)}' "$out/.pseudo.diff"
      ;;
    --stat)
      awk '/^\+\+\+ b\//{if(f!="")printf " %s | %d +\n", f, n; f=substr($0,7); n=0; next} /^\+[^+]/{n++} END{if(f!="")printf " %s | %d +\n", f, n}' "$out/.pseudo.diff"
      ;;
    *)
      cat "$out/.pseudo.diff"
      ;;
  esac
}

emit_diff() {
  if [ "$mode" = files ]; then
    pseudo_diff "$@"
  else
    git diff "$@" "$spec"
  fi
}

changed_lines="$(emit_diff --numstat | awk '{a+=$1; d+=$2} END {print a+d+0}')"
if [ "$changed_lines" -gt 4000 ]; then
  ctx=3
elif [ "$changed_lines" -gt 1500 ]; then
  ctx=10
else
  ctx=40
fi
emit_diff "-U$ctx" > "$out/context.patch.full"
if [ "$(wc -l < "$out/context.patch.full")" -gt "$MAX_PATCH_LINES" ]; then
  head -n "$MAX_PATCH_LINES" "$out/context.patch.full" > "$out/context.patch"
  {
    echo
    echo "*** TRUNCATED at $MAX_PATCH_LINES lines. The rest of the change is in \`pack/files/\` and \`pack/names.txt\`. ***"
  } >> "$out/context.patch"
  patch_truncated=yes
else
  mv "$out/context.patch.full" "$out/context.patch"
  patch_truncated=no
fi
rm -f "$out/context.patch.full"
emit_diff --stat > "$out/stat.txt"
emit_diff --name-status > "$out/names.txt"

if [ ! -s "$out/context.patch" ]; then
  echo "empty diff for $label ($spec)" >&2
  exit 4
fi

# Post-image of every changed file, so a lens can read the whole function
# without a `read` round trip. `--diff-filter=d` skips deletions (no post-image).
files_written=0
files_skipped=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if [ "$files_written" -ge "$MAX_FILES" ]; then
    files_skipped=$((files_skipped + 1))
    continue
  fi
  mkdir -p "$out/files/$(dirname "$p")"
  if [ -n "$head" ]; then
    git show "$head:$p" 2>/dev/null | head -n "$MAX_FILE_LINES" > "$out/files/$p" || true
  else
    head -n "$MAX_FILE_LINES" < "$p" > "$out/files/$p" 2>/dev/null || true
  fi
  files_written=$((files_written + 1))
done < <(emit_diff --name-only --diff-filter=d)

# Deleted lines, grouped by file: what a change REMOVED is invisible in the
# post-image, and it is where "the caller still expects this" bugs live.
# A DELETED file's post-image header is `+++ /dev/null`, so keying only on
# `+++ b/` attributed every one of its removed lines to whichever file came
# before it. Fall back to the `--- a/` pre-image path for exactly that case.
emit_diff \
  | awk '
      /^--- a\//    { prev = substr($0, 7); next }
      /^\+\+\+ b\// { f = substr($0, 7); next }
      /^\+\+\+ /     { f = prev; next }
      /^-[^-]/      { print f ": " substr($0, 2) }
    ' \
  > "$out/removed.txt" || true
[ -s "$out/removed.txt" ] || echo "NONE — this change removes no lines." > "$out/removed.txt"

# Every reference to a changed EXPORTED symbol from a file this PR did not
# touch — the integration lens's entire grep phase, done once. Exported only,
# and 4+ characters: a local `const graph` matches half the repo and buries the
# handful of hits that are actually about this change.
changed_paths="$(emit_diff --name-only)"
symbols="$(emit_diff \
  | grep -E '^[+-][[:space:]]*export[[:space:]]+(default[[:space:]]+)?(async[[:space:]]+)?(function|class|const|interface|type|enum)[[:space:]]+[A-Za-z_]' \
  | sed -E 's/.*(function|class|const|interface|type|enum)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*).*/\2/' \
  | awk 'length($0) >= 4' \
  | sort -u | head -n 60 || true)"
printf '%s\n' "$changed_paths" > "$out/.changed"
: > "$out/callers.raw"
if [ -n "$symbols" ]; then
  while IFS= read -r sym; do
    [ -n "$sym" ] || continue
    git grep -n -w -F "$sym" -- '*.ts' '*.tsx' '*.js' '*.sql' >> "$out/callers.raw" 2>/dev/null || true
  done <<< "$symbols"
fi
# Hits inside the changed files themselves are the diff, not its callers.
awk -F: 'NR==FNR{skip[$0]=1; next} !($1 in skip)' "$out/.changed" "$out/callers.raw" \
  | sort -u | head -n "$MAX_CALLER_LINES" > "$out/callers.txt" || true
rm -f "$out/.changed" "$out/callers.raw"
[ -s "$out/callers.txt" ] || echo "NONE — no references to changed symbols from outside the diff." > "$out/callers.txt"

# Added lines touching a security- or resource-sensitive surface. When this is
# NONE the risk lens short-circuits on one read instead of re-deriving it.
#
# CODE FILES ONLY. The risk lens is told to treat this file as authoritative,
# so whatever lands in it is read with elevated trust — and the keyword sweep
# happily matched the prose inside a workflow YAML `prompt:` body, handing any
# contributor who edits one a direct channel into the lens. Prose files carry
# no executable risk surface, so dropping them costs nothing and closes the
# channel. (The judges' `injected` question remains the general defence; this
# removes the most inviting path to it.)
emit_diff \
  | awk '
      /^\+\+\+ b\// { f = substr($0, 7)
                      code = (f ~ /\.(ts|tsx|js|jsx|mjs|cjs|sql|sh|bash|py|go|rs|rb|java|c|h|cc|cpp)$/)
                      next }
      /^\+\+\+ /     { code = 0; next }
      /^\+[^+]/     { if (code) print }
    ' \
  | grep -iE 'auth|token|secret|password|credential|exec|spawn|child_process|eval\(|sql|query\(|crypt|hash|sign|verify|fetch\(|request\(|http|cors|redirect|permission|chmod|readFile|writeFile|path\.join|while[[:space:]]*\(|for[[:space:]]*\(' \
  | head -n 200 > "$out/risk-surface.txt" || true
[ -s "$out/risk-surface.txt" ] || echo "NONE — this change touches no security-, IO-, or resource-sensitive surface in a code file." > "$out/risk-surface.txt"

{
  echo "# Review pack — $label"
  echo
  if [ -n "$spec" ]; then
    echo "Diff: \`$spec\`, $changed_lines changed lines, patch context \`-U$ctx\` (truncated: $patch_truncated)."
  else
    echo "No diff — reviewing $label as-is; every line in \`pack/context.patch\` is marked \`+\`. $changed_lines lines (truncated: $patch_truncated)."
  fi
  echo "Changed files written to \`pack/files/\`: $files_written (skipped over the $MAX_FILES cap: $files_skipped);"
  echo "each truncated at $MAX_FILE_LINES lines."
  echo
  echo '| file | what it holds |'
  echo '| --- | --- |'
  echo '| `pack/context.patch` | the diff with 40 lines of context — the enclosing function is already here |'
  echo '| `pack/files/<path>` | post-image of each changed file |'
  echo '| `pack/removed.txt` | every deleted line, grouped by file |'
  echo '| `pack/callers.txt` | references to changed symbols from files this PR did NOT touch |'
  echo '| `pack/risk-surface.txt` | added lines on a sensitive surface, or `NONE` |'
  echo '| `pack/stat.txt`, `pack/names.txt` | diffstat and name-status |'
  echo
  echo '## Diffstat'
  echo '```'
  cat "$out/stat.txt"
  echo '```'
} > "$out/INDEX.md"

echo "pack built: $files_written files, $(wc -l < "$out/context.patch") patch lines, $(wc -l < "$out/callers.txt") caller lines"

#!/usr/bin/env bash
# Event-contract touch-gate — docs/proposals/archive/event-contract-version.md §3.3.
#
# The contract-surface hash test (packages/store/test/contract-version.test.ts)
# catches every STRUCTURAL change to the fold contract (fact/intent shapes,
# status/reason literals). It is blind to one residue: a reducer that starts
# reading a previously-ignored field while the surface stays byte-identical —
# the fold changed, the hash did not. That residue lives entirely in
# reducers.ts. So: any diff that touches reducers.ts must either bump
# EVENT_CONTRACT_VERSION or carry an explicit no-bump marker. Two mechanical
# gates, no reliance on anyone remembering the bump table.
#
# Usage: scripts/check-contract-bump.sh [base-ref]   (default: origin/main)
set -euo pipefail

BASE="${1:-origin/main}"
REDUCERS="packages/store/src/reducers.ts"
PRAGMAS="packages/store/src/pragmas.ts"

changed="$(git diff --name-only "${BASE}...HEAD")"

if ! grep -qx "${REDUCERS}" <<<"${changed}"; then
  echo "contract touch-gate: ${REDUCERS} untouched — ok"
  exit 0
fi

# reducers.ts changed → require a version bump OR a no-bump marker in the diff.
pragmas_diff="$(git diff "${BASE}...HEAD" -- "${PRAGMAS}")"
if grep -qE '^\+[^+].*EVENT_CONTRACT_VERSION[[:space:]]*=[[:space:]]*[0-9]+' <<<"${pragmas_diff}"; then
  echo "contract touch-gate: EVENT_CONTRACT_VERSION bumped — ok"
  exit 0
fi

# The no-bump marker is deliberately self-service while the repo has a single
# maintainer: the author who writes the diff also writes the marker. When a
# second regular committer lands, this gate should grow CODEOWNERS-or-label
# enforcement so a no-bump claim is reviewed by someone other than its author.
reducers_diff="$(git diff "${BASE}...HEAD" -- "${REDUCERS}")"
if grep -qiE '^\+.*contract:[[:space:]]*no-bump' <<<"${reducers_diff}"; then
  echo "contract touch-gate: '// contract: no-bump' marker present — ok"
  exit 0
fi

cat >&2 <<'MSG'
::error::reducers.ts changed but EVENT_CONTRACT_VERSION was not bumped.

foldFacts semantics may have changed in a way the contract-surface hash cannot
see (the canonical case: a reducer now reads a field it previously ignored).
Choose one:

  • Real fold-contract change → bump EVENT_CONTRACT_VERSION in
    packages/store/src/pragmas.ts, then re-snapshot the surface:
      UPDATE_CONTRACT_SNAPSHOT=1 bun test packages/store/test/contract-version.test.ts

  • Genuinely fold-invariant (rename, comment, helper extraction) → add an
    inline marker to the reducers.ts diff:
      // contract: no-bump — <reason>

See docs/proposals/archive/event-contract-version.md §3.3.
MSG
exit 1

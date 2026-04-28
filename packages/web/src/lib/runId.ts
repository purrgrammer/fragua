// Run-id formatting for compact UI labels.
//
// ULIDs are 26 chars: 10 timestamp + 16 random. Plain prefix-truncation
// (slice(0, N)) collapses runs queued within the same ~30s bucket to
// the same visible string, which makes the Activity feed look like it
// has duplicates when it doesn't. We show `prefix…suffix` instead so
// the trailing random portion always disambiguates.

const PREFIX_LEN = 4;
const SUFFIX_LEN = 4;
// Anything shorter than prefix+suffix+1 isn't worth abbreviating.
const MIN_LEN_TO_TRUNCATE = PREFIX_LEN + SUFFIX_LEN + 1;

/** Compact run-id label: `01kq…drne` style. Returns the full id when
 * it's already short enough that truncation would save no space. */
export function shortRunId(runId: string): string {
  if (runId.length < MIN_LEN_TO_TRUNCATE) return runId;
  return `${runId.slice(0, PREFIX_LEN)}…${runId.slice(-SUFFIX_LEN)}`;
}

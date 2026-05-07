// Whitelist parser for the supported schedule intervals
// (proposal: docs/proposals/scheduled-runs.md).
//
// Shorthand whitelist: `30m`, `1h`, `6h`, `24h`, `3d`, `7d`. Cron
// expressions are explicitly out of scope; the `interval_ms` column on
// `schedules` is forward-compatible if cron is ever added later.

const TABLE: Record<string, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

export const SCHEDULE_INTERVALS: ReadonlyArray<string> = Object.keys(TABLE);

export class InvalidScheduleIntervalError extends Error {
  constructor(public readonly value: string) {
    super(`invalid schedule interval ${JSON.stringify(value)}: must be one of ${Object.keys(TABLE).join(", ")}`);
    this.name = "InvalidScheduleIntervalError";
  }
}

/** Parse a schedule interval shorthand to ms. Throws on anything
 *  outside the four-value whitelist (including the empty string,
 *  numeric strings, and `5m` / `1d` / `30s` style values). */
export function parseScheduleInterval(text: string): number {
  const ms = TABLE[text];
  if (ms === undefined) throw new InvalidScheduleIntervalError(text);
  return ms;
}

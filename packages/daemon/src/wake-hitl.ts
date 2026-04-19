// Wake paused_hitl runs that have a pending intent.hitl_input.
//
// The executor loop bails on paused_hitl runs because it treats them as
// terminal-for-now. To resume, a separate sweep transitions them back to
// 'queued' with a fact.run_resumed event. The actual HITL input is folded
// in on the next executor turn via the normal intent fold (the intent stays
// unapplied because we don't bump last_applied_seq to skip it).

import { ConcurrencyError, type IEventStore } from "@swarm/store";

export function wakePendingHitl(store: IEventStore): string[] {
  const woken: string[] = [];

  // We don't have a bulk "list runs by status" API. Walk candidates via
  // the daemon lock isn't useful — but the supervisor can call this
  // frequently with cheap poll. For now use a direct SQL escape hatch.
  const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
  if (db == null) return [];
  const rows = db
    .query<{ run_id: string; version: number; last_applied_seq: number }, []>(
      `SELECT run_id, version, last_applied_seq
         FROM run_state WHERE status = 'paused_hitl'`,
    )
    .all();

  for (const row of rows) {
    const hasHitl = db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM events
          WHERE run_id = ? AND seq > ? AND type = 'intent.hitl_input'
          LIMIT 1`,
      )
      .get(row.run_id, row.last_applied_seq);
    if (hasHitl == null) continue;

    try {
      store.appendFact(
        row.run_id,
        [
          {
            type: "fact.run_resumed",
            payload: { fromStatus: "paused_hitl", inputIntentSeq: hasHitl.seq },
          },
        ],
        row.version,
      );
      woken.push(row.run_id);
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) throw err;
      // Someone else moved it; skip.
    }
  }

  return woken;
}

// Shared run-follow/tail loop — used by `fragua run --follow` and
// `fragua runs watch`. Polls `readPlane.eventsSince` in a loop, renders each
// event, answers HITL gates inline (TTY), and returns the run's terminal exit
// code. A daemon must be running for events to appear; with none the run sits
// queued and this waits (Ctrl-C to stop).

import type { StoredEvent } from "@fragua/store";
import chalk from "chalk";
import { humanizeRoute, pickRoute } from "./route-picker.ts";
import type { StoreClient } from "./store-client.ts";

const POLL_MS = 200;
const BATCH = 500;

const TERMINAL_TYPES = new Set<string>([
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_paused_human",
  "fact.run_quarantined",
]);

/** Tail a run's event log to terminal: poll `readPlane.eventsSince`, render
 * each new event, return the run's terminal exit code. A daemon must be running
 * for events to appear — with none the run sits queued and this waits (Ctrl-C
 * to stop), same as the old SSE follow. */
export async function followRun(client: StoreClient, runId: string): Promise<number> {
  let cursor = 0;
  for (;;) {
    const batch = client.readPlane.eventsSince(runId, cursor, BATCH);
    for (const ev of batch) {
      renderEvent(ev);
      cursor = ev.seq;
      if (ev.type === "fact.run_paused_human") {
        // Answer the gate inline (TTY) and keep following — the daemon folds
        // the human_input and the run resumes. Off a TTY, exit so scripts
        // don't block on a prompt.
        if (await promptHumanGate(client, runId, ev)) continue;
        return 0;
      }
      if (TERMINAL_TYPES.has(ev.type)) {
        return ev.type === "fact.run_halted" ? 1 : ev.type === "fact.run_cancelled" ? 130 : 0;
      }
    }
    // A non-full batch means we've caught up to the live tail — wait for more.
    if (batch.length < BATCH) await sleep(POLL_MS);
  }
}

/** Render the HITL gate as an arrow-key select menu, write the chosen route via
 * the plane, and return true (keep following). Returns false — without writing —
 * off a TTY, on an empty gate, or on a cancel, so the caller exits and the
 * operator can answer later with `fragua runs respond`. */
async function promptHumanGate(client: StoreClient, runId: string, ev: StoredEvent): Promise<boolean> {
  const p = ev.payload as { text?: string; routes?: string[]; routeLabels?: Record<string, string> };
  const routes = p.routes ?? [];
  if (!process.stdin.isTTY || routes.length === 0) {
    console.log(chalk.yellow("run paused for human input — exiting (answer with `fragua runs respond`)."));
    return false;
  }
  const route = await pickRoute(routes, p.routeLabels ?? {}, p.text ?? "Choose how to proceed");
  if (route === undefined) {
    console.log(chalk.yellow("no choice made — exiting; answer later with `fragua runs respond`."));
    return false;
  }
  const built = client.plane.buildHuman({ route });
  if (!built.ok) {
    console.error(chalk.red(`respond: ${built.error}`));
    return false;
  }
  client.plane.commit(runId, built.intent);
  console.log(chalk.dim(`→ ${p.routeLabels?.[route] ?? humanizeRoute(route)} (resuming)`));
  return true;
}

export function renderEvent(ev: StoredEvent): void {
  const color = ev.type.startsWith("fact.run_completed")
    ? chalk.green
    : ev.type.startsWith("fact.run_halted") || ev.type.startsWith("fact.run_cancelled")
      ? chalk.red
      : ev.type.startsWith("intent.")
        ? chalk.blue
        : chalk.dim;
  console.log(`${chalk.dim(`[${ev.seq}]`)} ${color(ev.type)} ${JSON.stringify(ev.payload ?? {})}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

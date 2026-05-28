// Shared run-follow/tail loop — used by `fragua run --follow` and
// `fragua runs tail`. Polls `readPlane.eventsSince` in a loop, renders each
// event, answers HITL gates inline (TTY), and returns the run's terminal exit
// code through the shared `cliExitCode` map — so a followed run carries the
// same outcome detail as `fragua ci` (retry on occ_exhausted/timeout_exhausted,
// distinct codes for pause-vs-fail). A daemon must be running for events to
// appear; with none the run sits queued and this waits (Ctrl-C to stop).

import type { StoredEvent } from "@fragua/store";
import type { HaltReason, QuarantineReason } from "@fragua/types";
import chalk from "chalk";
import { cliExitCode } from "./cli-exit.ts";
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

/** A terminal (or unanswered-HITL) event → process exit code, through the
 * shared `cliExitCode` map. The reason rides on the fact's payload. */
function followExitCode(ev: StoredEvent): number {
  const reason = (ev.payload as { reason?: string }).reason;
  switch (ev.type) {
    case "fact.run_halted":
      return cliExitCode("halted", reason ? { halt: reason as HaltReason } : {});
    case "fact.run_cancelled":
      return cliExitCode("cancelled");
    case "fact.run_quarantined":
      return cliExitCode("quarantined", reason ? { quarantine: reason as QuarantineReason } : {});
    case "fact.run_paused_human":
      return cliExitCode("paused_human");
    default:
      return cliExitCode("completed"); // fact.run_completed
  }
}

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
        // Unanswered (off a TTY / no choice): the run still needs a human —
        // exit `needsHuman`, not 0, so a script doesn't read it as success.
        return followExitCode(ev);
      }
      if (TERMINAL_TYPES.has(ev.type)) {
        return followExitCode(ev);
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
  if (ev.type === "budget.warn") {
    const p = ev.payload as { scope?: unknown; metric?: unknown; actual?: unknown; limit?: unknown; ratio?: unknown };
    const scope = typeof p.scope === "string" ? p.scope : "?";
    const metric = typeof p.metric === "string" ? p.metric : "?";
    const pct = typeof p.ratio === "number" ? `${Math.round(p.ratio * 100)}%` : "80%";
    console.log(
      `${chalk.dim(`[${ev.seq}]`)} ${chalk.yellow(`⚠ ${ev.type}`)} ` +
        chalk.yellow(`${pct} of ${scope}:${metric} budget (actual ${p.actual ?? "?"}, limit ${p.limit ?? "?"})`),
    );
    return;
  }
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

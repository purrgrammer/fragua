// Shared run-follow/tail loop — used by `fragua run --follow` and
// `fragua runs tail`. Polls `readPlane.eventsSince` in a loop, renders each
// event, answers HITL gates inline (TTY), and returns the run's terminal exit
// code through the shared `cliExitCode` map — so a followed run carries the
// same outcome detail as `fragua ci` (retry on occ_exhausted/timeout_exhausted,
// distinct codes for pause-vs-fail). A daemon must be running for events to
// appear; with none the run sits queued and this waits (Ctrl-C to stop).

import type { StoredEvent } from "@fragua/store";
import {
  AUTO_WAKE_PAUSE_REASONS,
  type FactEvent,
  type HaltReason,
  type PauseReason,
  type QuarantineReason,
  TERMINAL_FACT_TYPES,
} from "@fragua/types";
import chalk from "chalk";
import { cliExitCode } from "./cli-exit.ts";
import { humanizeRoute, pickRoute } from "./route-picker.ts";
import type { StoreClient } from "./store-client.ts";

const POLL_MS = 200;
const BATCH = 500;

/** How long an empty tail may stay silent before we hint that no daemon may be
 * running. Long enough that a busy daemon's gaps never trip it. */
const IDLE_HINT_MS = 15_000;

/** The HITL picker, injectable so tests can drive the gate without a TTY. */
type RoutePicker = typeof pickRoute;

// Derived from `@fragua/types` (`TERMINAL_FACT_TYPES`, folded out of
// `SETTLED_STATUS_TERMINAL_FACT`) so the set that stops the follow/tail stream
// can't drift from the real terminal facts — a new settled status must name its
// terminal fact there, and this loop picks it up for free.
// `fact.run_paused` is deliberately not in that set: it is conditionally
// terminal (operator reasons stop; auto-wake reasons continue; `human`
// prompts), so it's handled explicitly in the loop below.
const isTerminalType = (type: string): boolean => TERMINAL_FACT_TYPES.has(type as FactEvent["type"]);

/** Per non-auto-wake pause reason: the verb an operator runs to unblock, shown
 * after the structural pause render so a followed stop is self-documenting. */
const PAUSE_HINTS: Record<Exclude<PauseReason, "provider_retry" | "handler_retry" | "timeout_retry">, string> = {
  operator: "resume with `fragua runs resume <run>`",
  provider_error: "fix creds, then `fragua runs resume <run>`",
  payment_required: "top up the provider, then `fragua runs resume <run>`",
  provider_exhausted: "switch provider / wait, then `fragua runs resume <run>`",
  engine_incompatible: "run a compatible daemon build, then `fragua runs resume <run>`",
  budget: "raise the cap with `fragua runs budget <run> ...`, then `fragua runs resume <run>`",
  max_retries: "grant retries with `fragua runs max-retries <run> ...`, then `fragua runs resume <run>`",
  goal_gate: "grant cycles with `fragua runs goal-gate <run> ...`, then `fragua runs resume <run>`",
  max_loops: "raise the ceiling with `fragua runs max-loops <run> ...`, then `fragua runs resume <run>`",
  abort_loop: "inspect node `<node>` with `fragua runs events <run>`, then `fragua runs resume <run>`",
};

/** A terminal (or unanswered-HITL) event → process exit code, through the
 * shared `cliExitCode` map. The reason rides on the fact's payload. */
function followExitCode(ev: StoredEvent): number {
  const payload = ev.payload as { reason?: string; status?: string };
  const reason = payload.reason;
  switch (ev.type) {
    case "fact.run_terminated":
      // status-discriminated terminal: completed | errored | aborted.
      if (payload.status === "aborted") return cliExitCode("cancelled");
      if (payload.status === "errored") return cliExitCode("halted", reason ? { halt: reason as HaltReason } : {});
      return cliExitCode("completed"); // status === "completed"
    case "fact.run_quarantined":
      return cliExitCode("quarantined", reason ? { quarantine: reason as QuarantineReason } : {});
    case "fact.run_paused":
      if (reason === "human") return cliExitCode("paused_human");
      return cliExitCode("paused", reason ? { pause: reason as PauseReason } : {});
    default:
      return cliExitCode("completed");
  }
}

/** Tail a run's event log to terminal: poll `readPlane.eventsSince`, render
 * each new event, return the run's terminal exit code. A daemon must be running
 * for events to appear — with none the run sits queued and this waits (Ctrl-C
 * to stop), same as the old SSE follow. `idleHintMs` is injectable so tests can
 * drive the silent-tail hint without a 15s wait. */
export async function followRun(
  client: StoreClient,
  runId: string,
  pick: RoutePicker = pickRoute,
  startCursor = 0,
  idleHintMs = IDLE_HINT_MS,
): Promise<number> {
  let cursor = startCursor;
  let lastProgressAt = Date.now();
  let idleHintShown = false;
  for (;;) {
    const batch = client.readPlane.eventsSince(runId, cursor, BATCH);
    for (const ev of batch) {
      renderEvent(ev);
      cursor = ev.seq;
      lastProgressAt = Date.now();
      if (ev.type === "fact.run_paused") {
        const reason = (ev.payload as { reason?: PauseReason | "human" }).reason;
        if (reason === "human") {
          // Answer the gate inline (TTY) and keep following — the daemon folds
          // the human_input and the run resumes. Off a TTY, exit so scripts
          // don't block on a prompt.
          if (await promptHumanGate(client, runId, ev, pick)) continue;
          // Unanswered (off a TTY / no choice): the run still needs a human —
          // exit `needsHuman`, not 0, so a script doesn't read it as success.
          return followExitCode(ev);
        }
        // Auto-wake reasons: the daemon owes a clock tick and will resume on
        // its own — keep following the retry rather than exiting.
        if (reason && AUTO_WAKE_PAUSE_REASONS.has(reason)) continue;
        // Operator-action pause: the run needs a human to steer. Exit non-zero.
        return followExitCode(ev);
      }
      if (isTerminalType(ev.type)) {
        return followExitCode(ev);
      }
    }
    // A non-full batch means we've caught up to the live tail — wait for more.
    if (batch.length < BATCH) {
      // Silent for a while? A queued run with no daemon produces no events at
      // all — hint once so the wait isn't presented as normal, then keep going.
      if (!idleHintShown && Date.now() - lastProgressAt >= idleHintMs) {
        console.log(chalk.dim("no events yet — is a daemon running? try: fragua harness"));
        idleHintShown = true;
      }
      await sleep(POLL_MS);
    }
  }
}

/** Poll the event log from `sinceSeq` until the gate is answered elsewhere. The
 * daemon's wake-pending sweep emits `fact.run_resumed` when an operator answers
 * in the web UI. Resolves on that (or any later terminal fact), or returns once
 * `signal` aborts (the inline picker won the race). */
async function pollUntilResumed(
  client: StoreClient,
  runId: string,
  sinceSeq: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    for (const ev of client.readPlane.eventsSince(runId, sinceSeq, BATCH)) {
      if (ev.type === "fact.run_resumed" || isTerminalType(ev.type)) {
        return;
      }
    }
    await sleep(POLL_MS);
  }
}

/** Render the HITL gate as an arrow-key select menu, write the chosen route via
 * the plane, and return true (keep following). Returns false — without writing —
 * off a TTY, on an empty gate, or on a cancel, so the caller exits and the
 * operator can answer later with `fragua runs respond`.
 *
 * Races the inline picker against a store poll: if the gate is answered in the
 * web UI while the menu is open, the poll wins, the picker is aborted, and we
 * keep following from the resumed event instead of blocking on stdin forever.
 * The post-pick re-check stops a second `intent.human_input` when both land at once. */
async function promptHumanGate(
  client: StoreClient,
  runId: string,
  ev: StoredEvent,
  pick: RoutePicker,
): Promise<boolean> {
  const p = ev.payload as { text?: string; routes?: string[]; routeLabels?: Record<string, string> };
  const routes = p.routes ?? [];
  if (!process.stdin.isTTY || routes.length === 0) {
    console.log(chalk.yellow("run paused for human input — exiting (answer with `fragua runs respond`)."));
    return false;
  }

  const ctrl = new AbortController();
  const picked = pick(routes, p.routeLabels ?? {}, p.text ?? "Choose how to proceed", ctrl.signal).then((route) => ({
    kind: "picked" as const,
    route,
  }));
  const externally = pollUntilResumed(client, runId, ev.seq, ctrl.signal).then(() => ({ kind: "external" as const }));
  const outcome = await Promise.race([picked, externally]);
  ctrl.abort();
  await picked.catch(() => {}); // let the loser settle: cancels the menu, restores the TTY

  if (outcome.kind === "external") {
    console.log(chalk.dim("gate answered elsewhere — resuming."));
    return true;
  }
  if (outcome.route === undefined) {
    console.log(chalk.yellow("no choice made — exiting; answer later with `fragua runs respond`."));
    return false;
  }
  if (client.readPlane.eventsSince(runId, ev.seq, BATCH).some((e) => e.type === "fact.run_resumed")) {
    console.log(chalk.dim("gate answered elsewhere — resuming."));
    return true;
  }
  const built = client.plane.buildHuman({ route: outcome.route });
  if (!built.ok) {
    console.error(chalk.red(`respond: ${built.error}`));
    return false;
  }
  client.plane.commit(runId, built.intent);
  console.log(chalk.dim(`→ ${p.routeLabels?.[outcome.route] ?? humanizeRoute(outcome.route)} (resuming)`));
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
  if (ev.type === "fact.run_paused") {
    const p = ev.payload as {
      reason?: PauseReason | "human";
      nodeId?: string;
      text?: string;
      resumeAt?: number;
      attempt?: number;
    };
    const reason = p.reason ?? "operator";
    if (reason === "human") {
      console.log(
        `${chalk.dim(`[${ev.seq}]`)} ${chalk.cyan(`⏸ ${ev.type}`)} ` +
          chalk.cyan(`needs human${p.nodeId ? ` @ ${p.nodeId}` : ""}${p.text ? `: ${p.text}` : ""}`),
      );
      return;
    }
    if (AUTO_WAKE_PAUSE_REASONS.has(reason)) {
      const secs = typeof p.resumeAt === "number" ? Math.max(0, Math.round((p.resumeAt - Date.now()) / 1000)) : null;
      const when = secs === null ? "shortly" : `in ~${secs}s`;
      const attempt = typeof p.attempt === "number" ? ` (attempt ${p.attempt})` : "";
      console.log(
        `${chalk.dim(`[${ev.seq}]`)} ${chalk.yellow(`⏳ ${ev.type}`)} ` +
          chalk.yellow(`auto-retry ${reason}${attempt} — resuming ${when}`),
      );
      return;
    }
    const rawHint = PAUSE_HINTS[reason as keyof typeof PAUSE_HINTS] ?? "`fragua runs resume <run>`";
    const hint = reason === "abort_loop" ? rawHint.replace("<node>", p.nodeId ?? "the looping node") : rawHint;
    console.log(
      `${chalk.dim(`[${ev.seq}]`)} ${chalk.red(`⏸ ${ev.type}`)} ` +
        chalk.red(`paused: ${reason}${p.nodeId ? ` @ ${p.nodeId}` : ""}`) +
        chalk.dim(` — ${hint}`),
    );
    return;
  }
  if (ev.type === "fact.run_quarantined") {
    const p = ev.payload as { reason?: QuarantineReason; orphanedIntents?: number[] };
    const reason = p.reason ?? "other";
    const orphans = p.orphanedIntents ?? [];
    const orphanNote = orphans.length > 0 ? ` (orphaned intents: ${orphans.join(", ")})` : "";
    console.log(
      `${chalk.dim(`[${ev.seq}]`)} ${chalk.red(`⚠ ${ev.type}`)} ` +
        chalk.red(`quarantined: ${reason}${orphanNote}`) +
        chalk.dim(" — resolve with `fragua runs unquarantine <run> --resolution treat_as_done|retry|cancel`"),
    );
    return;
  }
  const terminalStatus = ev.type === "fact.run_terminated" ? (ev.payload as { status?: string }).status : undefined;
  const color =
    terminalStatus === "completed"
      ? chalk.green
      : terminalStatus === "errored" || terminalStatus === "aborted"
        ? chalk.red
        : ev.type.startsWith("intent.")
          ? chalk.blue
          : chalk.dim;
  console.log(`${chalk.dim(`[${ev.seq}]`)} ${color(ev.type)} ${JSON.stringify(ev.payload ?? {})}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

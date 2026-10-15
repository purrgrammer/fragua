// `fragua doctor` — CLI liveness check. One screen of "is this fragua instance
// healthy?": the store path, the daemon and HTTP server liveness, and a
// one-line provider-credential summary. Liveness is judged from the processes
// and the rows together — every pid reported is probed (same host only) — so a
// missing row with a live process and a row left by a dead one both read
// truthfully. Read-only: it never writes, evicts, or clears a row.

import {
  DAEMON_LOCK_TTL_MS,
  type DaemonEventRow,
  type DaemonLockRow,
  EVENT_CONTRACT_VERSION,
  hostnameSafe,
  MIN_COMPATIBLE_CONTRACT_VERSION,
  type ServerEndpointRow,
} from "@fragua/store";
import chalk from "chalk";
import { type PidState, probePidState } from "../pid-probe.ts";
import { resolveStorePath, withStoreClient } from "../store-client.ts";
import { FRAGUA_VERSION } from "../version.ts";

export interface DoctorOptions {
  /** Explicit store path. Default `~/.fragua/fragua.db` (the harness store). */
  dbPath?: string;
  /** Pid liveness probe. Default `kill(pid, 0)`; injected by tests. */
  probePid?: (pid: number) => PidState;
  /** This host's name, compared against each row's. Default `hostnameSafe()`. */
  hostname?: string;
  now?: () => number;
}

/** What the renderers need to judge a row against the live process table. */
export interface LivenessEnv {
  now: number;
  hostname: string;
  probePid: (pid: number) => PidState;
}

export function doctorCommand(opts: DoctorOptions): Promise<number> {
  const path = resolveStorePath(opts);
  return withStoreClient(opts, ({ store }) => {
    const env: LivenessEnv = {
      now: (opts.now ?? Date.now)(),
      hostname: opts.hostname ?? hostnameSafe(),
      probePid: opts.probePid ?? probePidState,
    };
    console.log(chalk.bold("fragua doctor"));
    console.log(`  store:    ${path}`);
    const contractWindow =
      (MIN_COMPATIBLE_CONTRACT_VERSION as number) === (EVENT_CONTRACT_VERSION as number)
        ? `v${EVENT_CONTRACT_VERSION}`
        : `v${MIN_COMPATIBLE_CONTRACT_VERSION}–v${EVENT_CONTRACT_VERSION}`;
    console.log(`  engine:   ${FRAGUA_VERSION} ${chalk.dim(`(event-contract ${contractWindow})`)}`);

    const lock = store.currentDaemonLock();
    const lastLifecycle = store.latestDaemonLifecycleEvent();
    const daemon = describeDaemon(lock, lastLifecycle, env);
    console.log(`  daemon:   ${daemon.text}`);
    if (!daemon.alive) {
      console.log(`            ${formatLastExit(lastLifecycle)}`);
    }

    console.log(`  server:   ${describeServer(store.currentServerEndpoint(), lock, env)}`);

    const creds = store.listProviderCredentials();
    if (creds.length === 0) {
      console.log(`  providers: ${chalk.yellow("none")} ${chalk.dim("(`fragua providers add`)")}`);
    } else {
      console.log(`  providers: ${creds.map((c) => c.provider).join(", ")}`);
    }
    return 0;
  });
}

/** Render the daemon line from the lock row and the process it names.
 *  - alive + fresh heartbeat → `alive`
 *  - alive + stale heartbeat → the child's own tick was starved (host slept)
 *  - dead pid + row → a stale lock the next harness start evicts
 *  - no row → the newest `daemon.started` pid if it is still alive on this
 *    host (a daemon running without a lock), else `no daemon`
 *  A foreign-host row, or a pid we may not signal (EPERM), is taken at its
 *  word: the probe can't say anything about it. `alive` is whether a daemon
 *  process is believed to be running. Exported for tests. */
export function describeDaemon(
  lock: DaemonLockRow | null,
  lastLifecycle: DaemonEventRow | null,
  env: LivenessEnv,
): { text: string; alive: boolean } {
  if (lock == null) {
    if (lastLifecycle?.type === "daemon.started") {
      const p = lastLifecycle.payload as { pid: number; hostname: string };
      if (p.hostname === env.hostname && env.probePid(p.pid) === "alive") {
        return {
          text: `${chalk.yellow(`running without a lock: pid ${p.pid}`)} ${chalk.dim(
            `(started ${new Date(lastLifecycle.ts).toISOString()}; restart the harness)`,
          )}`,
          alive: true,
        };
      }
    }
    return { text: `${chalk.yellow("no daemon")} ${chalk.dim("(runs sit queued)")}`, alive: false };
  }

  const ageMs = env.now - lock.heartbeatAt;
  const ageS = Math.max(0, Math.round(ageMs / 1000));
  const stale = ageMs > DAEMON_LOCK_TTL_MS;
  const harness = lock.harnessPid !== null ? `, harness pid ${lock.harnessPid}` : "";
  const where = chalk.dim(`pid ${lock.pid} @ ${lock.hostname}${harness}`);
  const state: PidState | "foreign" = lock.hostname === env.hostname ? env.probePid(lock.pid) : "foreign";

  if (state === "foreign" || state === "unknown") {
    const health = stale ? chalk.red(`stale (${ageS}s)`) : chalk.green(`alive (${ageS}s)`);
    const why = state === "foreign" ? "pid not probed: other host" : "pid not probeable: EPERM";
    return { text: `${health} ${where} ${chalk.dim(`(${why})`)}`, alive: !stale };
  }
  if (state === "dead") {
    return {
      text: `${chalk.red(`dead (pid ${lock.pid} gone; stale lock, next harness start evicts it)`)} ${where}`,
      alive: false,
    };
  }
  if (stale) {
    return {
      text: `${chalk.yellow(`alive, heartbeat stale ${ageS}s (host slept? the harness will respawn it)`)} ${where}`,
      alive: true,
    };
  }
  return { text: `${chalk.green(`alive (${ageS}s)`)} ${where}`, alive: true };
}

/** Render the server line from the `server_endpoint` row and its pid. A row
 *  with no hostname (written before schema v9) or a foreign one is shown
 *  unprobed. With no row, a live supervising harness on this host (it hosts
 *  the server in-process) means a server running without its row. Exported
 *  for tests. */
export function describeServer(
  endpoint: ServerEndpointRow | null,
  lock: DaemonLockRow | null,
  env: LivenessEnv,
): string {
  if (endpoint == null) {
    if (lock?.harnessPid != null && lock.hostname === env.hostname && env.probePid(lock.harnessPid) === "alive") {
      return chalk.yellow(`running without an endpoint row: harness pid ${lock.harnessPid}`);
    }
    return `${chalk.yellow("none")} ${chalk.dim("(Web UI not served)")}`;
  }
  const where = chalk.dim(`pid ${endpoint.pid}`);
  if (endpoint.hostname === null || endpoint.hostname !== env.hostname) {
    const why = endpoint.hostname === null ? "pid not probed: no host recorded" : "pid not probed: other host";
    return `${endpoint.url} ${where} ${chalk.dim(`(${why})`)}`;
  }
  const state = env.probePid(endpoint.pid);
  if (state === "dead") {
    return `${chalk.red(`dead (pid ${endpoint.pid} gone; stale endpoint)`)} ${chalk.dim(endpoint.url)}`;
  }
  if (state === "unknown") {
    return `${endpoint.url} ${where} ${chalk.dim("(pid not probeable: EPERM)")}`;
  }
  return `${endpoint.url} ${chalk.green("alive")} ${where}`;
}

/** Render the "last exit:" line from the newest daemon lifecycle row.
 *  No row → nothing ever recorded; a `daemon.started` row with no later
 *  stop → the prior daemon crashed hard (it never reached its shutdown
 *  append). Exported for tests. */
export function formatLastExit(row: DaemonEventRow | null): string {
  if (row == null) return `last exit: ${chalk.dim("none recorded")}`;
  const when = new Date(row.ts).toISOString();
  if (row.type === "daemon.started") {
    const p = row.payload as { pid: number };
    return `last exit: ${chalk.red("no shutdown record")} ${chalk.dim(`(started ${when}, pid ${p.pid} — likely crash)`)}`;
  }
  const p = row.payload as {
    pid: number;
    reason: string;
    detail?: string;
    leaked?: Array<{ runId: string; nodeId: string }>;
  };
  const reason =
    p.reason === "leak_limit" || p.reason === "error" || p.reason === "lock_lost" ? chalk.red(p.reason) : p.reason;
  const detail = p.detail !== undefined ? `, ${p.detail}` : "";
  let line = `last exit: ${reason} at ${when} ${chalk.dim(`(pid ${p.pid}${detail})`)}`;
  if (p.reason === "leak_limit" && p.leaked !== undefined && p.leaked.length > 0) {
    line += ` — leaked: ${p.leaked.map((l) => `${l.runId}/${l.nodeId}`).join(", ")}`;
  }
  return line;
}

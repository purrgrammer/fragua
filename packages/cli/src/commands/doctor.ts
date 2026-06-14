// `fragua doctor` — CLI liveness check. One screen of "is this fragua instance
// healthy?": the store path, the daemon lock (alive vs stale heartbeat), the
// HTTP server endpoint, and a one-line provider-credential summary. Read-only,
// direct store-client — the operate skill's forensics process-level checks
// without raw SQL on `daemon_lock` / `server_endpoint`.

import { type DaemonEventRow, EVENT_CONTRACT_VERSION, MIN_COMPATIBLE_CONTRACT_VERSION } from "@fragua/store";
import chalk from "chalk";
import { resolveStorePath, withStoreClient } from "../store-client.ts";
import { FRAGUA_VERSION } from "../version.ts";

export interface DoctorOptions {
  /** Explicit store path. Default `~/.fragua/fragua.db` (the harness store). */
  dbPath?: string;
}

// A daemon heartbeats every ~10s; the supervisor treats a lock as stale past
// ~30s without a beat. Match that here so `doctor` and the daemon agree.
const STALE_HEARTBEAT_MS = 30_000;

export function doctorCommand(opts: DoctorOptions): Promise<number> {
  const path = resolveStorePath(opts);
  return withStoreClient(opts, ({ store }) => {
    console.log(chalk.bold("fragua doctor"));
    console.log(`  store:    ${path}`);
    const contractWindow =
      (MIN_COMPATIBLE_CONTRACT_VERSION as number) === (EVENT_CONTRACT_VERSION as number)
        ? `v${EVENT_CONTRACT_VERSION}`
        : `v${MIN_COMPATIBLE_CONTRACT_VERSION}–v${EVENT_CONTRACT_VERSION}`;
    console.log(`  engine:   ${FRAGUA_VERSION} ${chalk.dim(`(event-contract ${contractWindow})`)}`);

    const lock = store.currentDaemonLock();
    let daemonAlive = false;
    if (lock == null) {
      console.log(`  daemon:   ${chalk.yellow("no daemon")} ${chalk.dim("(runs sit queued)")}`);
    } else {
      const ageMs = Date.now() - lock.heartbeatAt;
      const ageS = Math.max(0, Math.round(ageMs / 1000));
      const stale = ageMs > STALE_HEARTBEAT_MS;
      daemonAlive = !stale;
      const health = stale ? chalk.red(`stale (${ageS}s)`) : chalk.green(`alive (${ageS}s)`);
      console.log(`  daemon:   ${health} ${chalk.dim(`pid ${lock.pid} @ ${lock.hostname}`)}`);
    }
    if (!daemonAlive) {
      console.log(`            ${formatLastExit(store.latestDaemonLifecycleEvent())}`);
    }

    const endpoint = store.currentServerEndpoint();
    if (endpoint == null) {
      console.log(`  server:   ${chalk.yellow("none")} ${chalk.dim("(Web UI not served)")}`);
    } else {
      console.log(`  server:   ${endpoint.url} ${chalk.dim(`pid ${endpoint.pid}`)}`);
    }

    const creds = store.listProviderCredentials();
    if (creds.length === 0) {
      console.log(`  providers: ${chalk.yellow("none")} ${chalk.dim("(`fragua providers add`)")}`);
    } else {
      console.log(`  providers: ${creds.map((c) => c.provider).join(", ")}`);
    }
    return 0;
  });
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
  const reason = p.reason === "leak_limit" || p.reason === "error" ? chalk.red(p.reason) : p.reason;
  const detail = p.detail !== undefined ? `, ${p.detail}` : "";
  let line = `last exit: ${reason} at ${when} ${chalk.dim(`(pid ${p.pid}${detail})`)}`;
  if (p.reason === "leak_limit" && p.leaked !== undefined && p.leaked.length > 0) {
    line += ` — leaked: ${p.leaked.map((l) => `${l.runId}/${l.nodeId}`).join(", ")}`;
  }
  return line;
}

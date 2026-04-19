// `swarm daemon` — run the packages/daemon process against the local store.
//
// Wires up: SqliteStore on .swarm/swarm.db, a Dispatcher with the auto
// resolver, a stub LlmClient (no-op calls), an empty ToolRegistry. Real
// runtime usage plugs richer dependencies via an extension API (future).

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { handler } from "@swarm/core";
import {
  autoDispatcherResolver,
  Dispatcher,
  startDaemon,
} from "@swarm/daemon";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";

export interface DaemonCommandOptions {
  /** Working directory used to resolve the store path. Default `process.cwd()`. */
  cwd?: string;
  /** Max concurrent runs. Default 4. */
  concurrency?: number;
}

export async function daemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = resolve(cwd, ".swarm/swarm.db");
  mkdirSync(dirname(storePath), { recursive: true });

  const store = new SqliteStore({ path: storePath });
  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));

  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  const signalCtrl = new AbortController();
  const onSig = () => signalCtrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  console.log(chalk.green(`swarm daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${opts.concurrency ?? 4}`));
  console.log(chalk.dim(`  press Ctrl-C to stop`));

  let exitCode = 0;
  try {
    const handle = startDaemon({
      store,
      dispatcher,
      tools,
      llmCall,
      ...(opts.concurrency !== undefined
        ? { maxConcurrentRuns: opts.concurrency }
        : {}),
      shutdownSignal: signalCtrl.signal,
    });
    await handle.done;
  } catch (err) {
    console.error(chalk.red(`daemon error: ${(err as Error).message}`));
    exitCode = 1;
  } finally {
    store.close();
  }
  return exitCode;
}

// `swarm daemon` — run the packages/daemon process against the local store.
//
// Out of the box the daemon uses a stub LLM. Pass `--provider` + `--model`
// (or omit both for the defaults) and the auto-dispatcher routes every
// `box` node through a PiCodergenBackend so real LLM calls fire. Handlers
// of other shapes (Mdiamond start, Msquare exit, hexagon wait.human, etc.)
// stay on the trivial transitions.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { makeCodergenHandler, PiCodergenBackend } from "@swarm/agent";
import { handler } from "@swarm/core";
import {
  autoDispatcherResolver,
  Dispatcher,
  startDaemon,
} from "@swarm/daemon";
import { SqliteStore } from "@swarm/store";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";

export interface DaemonCommandOptions {
  /** Working directory used to resolve the store path. Default `process.cwd()`. */
  cwd?: string;
  /** Max concurrent runs. Default 4. */
  concurrency?: number;
  /** LLM provider. When set with `--model`, enables the real codergen path. */
  provider?: string;
  /** Model id. */
  model?: string;
}

export async function daemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = resolve(cwd, ".swarm/swarm.db");
  mkdirSync(dirname(storePath), { recursive: true });

  const store = new SqliteStore({ path: storePath });
  const dispatcher = new Dispatcher();

  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  // Configure the LLM-backed codergen factory when provider+model are set.
  const useLlm = opts.provider != null && opts.model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
  if (useLlm) {
    const env = new LocalEnvironment({ cwd });
    const backendOpts = {
      registry: new ToolRegistry(),
      env,
      defaultModel: { provider: opts.provider!, model: opts.model! },
    };
    codergenFactory = (node, nextNode) =>
      makeCodergenHandler({
        node,
        nextNode,
        backendOpts,
      });
  }
  dispatcher.setResolver(
    autoDispatcherResolver({
      store,
      ...(codergenFactory ? { codergenFactory } : {}),
    }),
  );

  const signalCtrl = new AbortController();
  const onSig = () => signalCtrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  console.log(chalk.green(`swarm daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${opts.concurrency ?? 4}`));
  console.log(
    chalk.dim(
      `  llm: ${useLlm ? `${opts.provider}/${opts.model}` : "stub (provide --provider + --model for real LLM)"}`,
    ),
  );
  console.log(chalk.dim(`  press Ctrl-C to stop`));

  let exitCode = 0;
  try {
    const handleRef = startDaemon({
      store,
      dispatcher,
      tools,
      llmCall,
      ...(opts.concurrency !== undefined
        ? { maxConcurrentRuns: opts.concurrency }
        : {}),
      shutdownSignal: signalCtrl.signal,
    });
    // Keep PiCodergenBackend imported so bun tree-shaker doesn't drop it
    // when useLlm is false at startup.
    void PiCodergenBackend;
    await handleRef.done;
  } catch (err) {
    console.error(chalk.red(`daemon error: ${(err as Error).message}`));
    exitCode = 1;
  } finally {
    store.close();
  }
  return exitCode;
}

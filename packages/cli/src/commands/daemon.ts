// `swarm daemon` — run the packages/daemon process against the local store.
//
// Out of the box the daemon uses a stub LLM. Pass `--provider` + `--model`
// (or omit both for the defaults) and the auto-dispatcher routes every
// `box` node through a PiCodergenBackend so real LLM calls fire. Handlers
// of other shapes (Mdiamond start, Msquare exit, hexagon wait.human, etc.)
// stay on the trivial transitions.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { firstCredentialedProvider, makeCodergenHandler, PiCodergenBackend } from "@swarm/agent";
import * as handler from "@swarm/core/handler";
import { autoDispatcherResolver, Dispatcher, startDaemon } from "@swarm/daemon";
import { SqliteStore } from "@swarm/store";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";
import { loadConfig } from "../config.ts";

export interface DaemonCommandOptions {
  /** Working directory used to resolve the store path. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit store path. Overrides `<cwd>/.swarm/swarm.db`. */
  dbPath?: string;
  /** Max concurrent runs. Default 4. */
  concurrency?: number;
  /** LLM provider. When set with `--model`, enables the real codergen path. */
  provider?: string;
  /** Model id. */
  model?: string;
}

export async function daemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".swarm/swarm.db");
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

  // Resolve provider/model. Precedence: CLI flags > .swarm/config.yaml
  // defaults > env autodetect > stub.
  const config = await loadConfig(cwd);
  const cfgProvider = config.defaults?.provider;
  const cfgModel = config.defaults?.model;
  let provider = opts.provider;
  let model = opts.model;
  let llmSource: "flags" | "config" | "env" | "stub" = "stub";
  if (provider != null && model != null) {
    llmSource = "flags";
  } else if (provider == null && model == null && cfgProvider && cfgModel) {
    provider = cfgProvider;
    model = cfgModel;
    llmSource = "config";
  } else if (provider == null && model == null) {
    const auto = firstCredentialedProvider();
    if (auto?.defaultModel) {
      provider = auto.name;
      model = auto.defaultModel;
      llmSource = "env";
    }
  }
  const concurrency = opts.concurrency ?? config.concurrency ?? 4;

  const useLlm = provider != null && model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
  if (useLlm) {
    const env = new LocalEnvironment({ cwd });
    const backendOpts = {
      registry: new ToolRegistry(),
      env,
      defaultModel: { provider: provider!, model: model! },
    };
    codergenFactory = (node, nextNode) =>
      makeCodergenHandler({
        node,
        nextNode,
        backendOpts,
      });
  }
  void PiCodergenBackend;
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
  console.log(chalk.dim(`  concurrency: ${concurrency}`));
  const sourceSuffix =
    llmSource === "env" ? " (auto-detected from env)" : llmSource === "config" ? " (from .swarm/config.yaml)" : "";
  const llmLabel = useLlm
    ? `${provider}/${model}${sourceSuffix}`
    : "stub (set a provider API key, or pass --provider + --model)";
  console.log(chalk.dim(`  llm default: ${llmLabel}`));
  if (useLlm) {
    console.log(chalk.dim(`  nodes can override via \`provider=\`/\`model=\` attrs`));
  }
  console.log(chalk.dim(`  press Ctrl-C to stop`));

  let exitCode = 0;
  try {
    const handleRef = startDaemon({
      store,
      dispatcher,
      tools,
      llmCall,
      maxConcurrentRuns: concurrency,
      shutdownSignal: signalCtrl.signal,
    });
    await handleRef.done;
  } catch (err) {
    console.error(chalk.red(`daemon error: ${(err as Error).message}`));
    exitCode = 1;
  } finally {
    store.close();
  }
  return exitCode;
}

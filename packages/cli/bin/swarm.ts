#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.
//
// Commands that depended on the legacy fs-based control plane (run, daemon,
// pause, cancel, steer, resume, list, dashboard) were removed in the
// rearchitecture. They will be reintroduced in M5 as thin shells over the
// HTTP intent routes once the store-backed runtime is the default.

import cac from "cac";
import chalk from "chalk";
import { daemonCommand, daemonStopCommand } from "../src/commands/daemon.ts";
import { dbCommand } from "../src/commands/db.ts";
import { providersCommand } from "../src/commands/providers.ts";
import { runCommand } from "../src/commands/run.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

cli.command("validate <workflow>", "Parse + lint a workflow without executing").action(async (workflow: string) => {
  const code = await validateCommand(workflow);
  process.exit(code);
});

cli.command("providers", "List supported LLM providers and which ones have credentials").action(() => {
  process.exit(providersCommand());
});

cli
  .command("serve", "Start the HTTP + SSE server in the foreground (Ctrl-C to stop)")
  .option("--port <n>", "TCP port to bind (default 0 = ephemeral; writes <db-dir>/serve.json)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db); enables parallel swarms")
  .option("--dev", "Spawn Vite for HMR'd frontend; API stays on <port>, UI prints separately")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const portRaw = options["port"];
    const portNum =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : undefined;
    const portExplicit = portNum !== undefined && Number.isFinite(portNum);
    const code = await serveCommand({
      // Default to 0 (ephemeral) — the URL is published to <db-dir>/serve.json
      // so `swarm run` and friends discover it automatically.
      port: portExplicit ? portNum! : 0,
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(options["dev"] === true ? { dev: true } : {}),
    });
    process.exit(code);
  });

cli
  .command("daemon stop", "SIGTERM the running daemon identified by the store's daemon_lock row")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const code = await daemonStopCommand({
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
    });
    process.exit(code);
  });

cli
  .command("daemon", "Run the store-backed execution daemon in the foreground")
  .option("--concurrency <n>", "Max concurrent runs (default 4)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db); enables parallel swarms")
  .option("--provider <name>", "LLM provider override (default: auto-detected from env)")
  .option("--model <id>", "Model id override (e.g. claude-opus-4-7)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const concurrencyRaw = options["concurrency"];
    const concurrency =
      typeof concurrencyRaw === "number"
        ? concurrencyRaw
        : typeof concurrencyRaw === "string"
          ? Number.parseInt(concurrencyRaw, 10)
          : undefined;
    const code = await daemonCommand({
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(concurrency !== undefined && Number.isFinite(concurrency) ? { concurrency } : {}),
      ...(pick("provider") !== undefined ? { provider: pick("provider")! } : {}),
      ...(pick("model") !== undefined ? { model: pick("model")! } : {}),
    });
    process.exit(code);
  });

cli
  .command("db <action>", "DB maintenance: vacuum | gc-blobs | backup")
  .option("--to <path>", "`backup` only: destination path")
  .option("--limit <n>", "`gc-blobs` only: max rows per pass (default 1000)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .action(async (action: string, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    if (action !== "vacuum" && action !== "gc-blobs" && action !== "backup") {
      console.error(chalk.red(`unknown db action: ${action}`));
      console.error(chalk.dim("  valid actions: vacuum | gc-blobs | backup"));
      process.exit(1);
    }
    const limitRaw = options["limit"];
    const limit =
      typeof limitRaw === "number"
        ? limitRaw
        : typeof limitRaw === "string"
          ? Number.parseInt(limitRaw, 10)
          : undefined;
    const code = await dbCommand({
      action,
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(pick("to") !== undefined ? { to: pick("to")! } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    process.exit(code);
  });

cli
  .command(
    "run <workflow> [...input]",
    "Upload a DOT workflow, enqueue a run, stream events to stdout. " +
      "Trailing positional args are joined with ' ' and piped into the workflow's " +
      "\\$ARGUMENTS token (overridden by --input when both are given)",
  )
  .option("--url <url>", "Server URL (default: discovered via serve.json, else localhost:3000)")
  .option("--input <text>", "Explicit \\$ARGUMENTS value — wins over trailing positional args")
  .option("--priority <n>", "Priority tie-breaker (default 0)")
  .option("--no-follow", "Print the run id and exit without streaming")
  .option("--cwd <path>", "Base directory for relative workflow paths")
  .option("--db <path>", "Store path; discovers server at <dirname(db)>/serve.json")
  .action(async (workflow: string, positional: string[], options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const priorityRaw = options["priority"];
    const priority =
      typeof priorityRaw === "number"
        ? priorityRaw
        : typeof priorityRaw === "string"
          ? Number.parseInt(priorityRaw, 10)
          : undefined;
    const explicit = pick("input");
    const joined = Array.isArray(positional) && positional.length > 0 ? positional.join(" ") : undefined;
    const input = explicit ?? joined;
    const code = await runCommand({
      workflow,
      ...(pick("url") !== undefined ? { url: pick("url")! } : {}),
      ...(priority !== undefined && Number.isFinite(priority) ? { priority } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(input !== undefined ? { input } : {}),
      // cac renders `--no-follow` as `options.follow === false`.
      ...(options["follow"] === false ? { follow: false } : {}),
    });
    process.exit(code);
  });

cli.help();
cli.version("0.0.0");
const parsed = cli.parse(process.argv, { run: false });

if (!cli.matchedCommand && !parsed.options["help"] && !parsed.options["version"]) {
  cli.outputHelp();
  process.exit(0);
}

try {
  await cli.runMatchedCommand();
} catch (err) {
  const isCacError = err instanceof Error && err.constructor.name === "CACError";
  if (isCacError) {
    console.error(chalk.red(`error: ${(err as Error).message}`));
    cli.outputHelp();
    process.exit(1);
  }
  throw err;
}

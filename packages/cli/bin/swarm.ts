#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.
//
// Commands that depended on the legacy fs-based control plane (run, daemon,
// pause, cancel, steer, resume, list, dashboard) were removed in the
// rearchitecture. They will be reintroduced in M5 as thin shells over the
// HTTP intent routes once the store-backed runtime is the default.

import { resolveModelsPath } from "@swarm/agent";
import cac from "cac";
import chalk from "chalk";
import { daemonCommand, daemonStopCommand } from "../src/commands/daemon.ts";
import { dbCommand } from "../src/commands/db.ts";
import { gcCommand, parseDuration } from "../src/commands/gc.ts";
import { harnessCommand } from "../src/commands/harness.ts";
import { initCommand } from "../src/commands/init.ts";
import {
  providersAddCommand,
  providersAddCustomCommand,
  providersHelpCommand,
  providersListCommand,
  providersLoginCommand,
  providersLogoutCommand,
  providersRmCommand,
  providersTestCommand,
} from "../src/commands/providers.ts";
import { runCommand } from "../src/commands/run.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

cli.command("validate <workflow>", "Parse + lint a workflow without executing").action(async (workflow: string) => {
  const code = await validateCommand(workflow);
  process.exit(code);
});

cli
  .command("init", "Initialize this directory as a swarm project (writes .swarm/config.jsonc)")
  .option("--cwd <path>", "Project root (default process.cwd)")
  .action(async (options: Record<string, unknown>) => {
    const cwd = typeof options["cwd"] === "string" ? (options["cwd"] as string) : undefined;
    const code = await initCommand(cwd !== undefined ? { cwd } : {});
    process.exit(code);
  });

// `swarm providers [action]` — bare form prints subcommand help, per
// the "top-level commands without arguments should list options"
// convention. cac 6.x doesn't cleanly match multi-word commands
// (`swarm providers ls` fell through to the parent), so actions are
// dispatched via a positional.
cli
  .command(
    "providers [action] [target] [extra]",
    "Manage LLM provider credentials + custom models (run without args for help)",
  )
  .option("--custom", "`add` only: add a custom (OpenAI-compatible) provider to models.json")
  .action(
    async (
      action: string | undefined,
      target: string | undefined,
      extra: string | undefined,
      options: Record<string, unknown>,
    ) => {
      switch (action) {
        case undefined:
          process.exit(providersHelpCommand());
          break;
        case "ls":
          process.exit(providersListCommand());
          break;
        case "add":
          if (options["custom"]) {
            process.exit(await providersAddCustomCommand(resolveModelsPath()));
          } else {
            process.exit(await providersAddCommand(target));
          }
          break;
        case "rm":
          process.exit(await providersRmCommand(target));
          break;
        case "test":
          process.exit(await providersTestCommand(target, extra));
          break;
        case "login":
          process.exit(await providersLoginCommand(target));
          break;
        case "logout":
          process.exit(await providersLogoutCommand(target));
          break;
        default:
          console.error(chalk.red(`unknown providers action: ${action}`));
          providersHelpCommand();
          process.exit(1);
      }
    },
  );

cli
  .command("harness", "Supervise the daemon + HTTP server as a foreground process (Ctrl-C to stop)")
  .option("--port <n>", "TCP port for HTTP (default 0 = ephemeral)")
  .option("--db <path>", "Store path (default ~/.swarm/swarm.db)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const portRaw = options["port"];
    const portNum =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : undefined;
    const code = await harnessCommand({
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(portNum !== undefined && Number.isFinite(portNum) ? { port: portNum } : {}),
    });
    process.exit(code);
  });

cli
  .command("serve", "Start the HTTP + SSE server in the foreground (Ctrl-C to stop)")
  .option("--port <n>", "TCP port to bind (default 0 = ephemeral; writes <db-dir>/serve.json)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db); enables parallel swarms")
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
    });
    process.exit(code);
  });

// `swarm daemon [action]` — bare form prints help; `start` runs the
// daemon foreground; `stop` SIGTERMs the process holding the store
// lock. cac 6.x doesn't cleanly match multi-word commands so actions
// are dispatched via a positional (same pattern as providers / db).
cli
  .command("daemon [action]", "Run or stop the execution daemon (run without args for help)")
  .option("--concurrency <n>", "`start` only: max concurrent runs (default 8)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .option("--llm-provider <name>", "`start` only: LLM provider override (default: auto-detected)")
  .option("--llm-model <id>", "`start` only: model id override (e.g. claude-opus-4-7)")
  .action(async (action: string | undefined, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    if (action === undefined) {
      console.log(chalk.bold("swarm daemon — run or stop the execution daemon\n"));
      console.log("Subcommands:");
      console.log(`  ${chalk.cyan("start")}    Run the store-backed daemon in the foreground (Ctrl-C to stop)`);
      console.log(`  ${chalk.cyan("stop")}     SIGTERM the running daemon identified by the store's daemon_lock`);
      process.exit(0);
    }
    if (action === "stop") {
      const code = await daemonStopCommand({
        ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
        ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      });
      process.exit(code);
    }
    if (action === "start") {
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
        // cac kebab-cases multi-word options: `--llm-provider` arrives as
        // `options.llmProvider`. The pick() helper reads the kebab key.
        ...(pick("llmProvider") !== undefined ? { llmProvider: pick("llmProvider")! } : {}),
        ...(pick("llmModel") !== undefined ? { llmModel: pick("llmModel")! } : {}),
      });
      process.exit(code);
    }
    console.error(chalk.red(`unknown daemon action: ${action}`));
    console.error(chalk.dim("  valid actions: start | stop"));
    process.exit(1);
  });

cli
  .command("gc", "Garbage-collect run artefacts")
  .option("--branches", "Prune `swarm/runs/*` branches whose runs are past the retention window")
  .option("--older-than <duration>", "Retention window (e.g. 30d, 12h, 2w). Default 30d.")
  .option("--dry-run", "Report what would be deleted without touching anything")
  .option("--cwd <path>", "Repo root (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    if (options["branches"] !== true) {
      console.error(chalk.red("gc: --branches is required (no other targets supported yet)"));
      process.exit(1);
    }
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(pick("olderThan"));
    } catch (err) {
      console.error(chalk.red(`gc: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    const code = await gcCommand({
      target: "branches",
      olderThanMs,
      ...(options["dryRun"] === true ? { dryRun: true } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
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

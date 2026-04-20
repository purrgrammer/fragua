#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.
//
// Commands that depended on the legacy fs-based control plane (run, daemon,
// pause, cancel, steer, resume, list, dashboard) were removed in the
// rearchitecture. They will be reintroduced in M5 as thin shells over the
// HTTP intent routes once the store-backed runtime is the default.

import cac from "cac";
import chalk from "chalk";
import { daemonCommand } from "../src/commands/daemon.ts";
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
  .option("--port <n>", "TCP port to bind (default 3000; pass 0 for ephemeral)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const portRaw = options["port"];
    const portNum =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : undefined;
    const code = await serveCommand({
      ...(portNum !== undefined && Number.isFinite(portNum) ? { port: portNum } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
    });
    process.exit(code);
  });

cli
  .command("daemon", "Run the store-backed execution daemon in the foreground")
  .option("--concurrency <n>", "Max concurrent runs (default 4)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--provider <name>", "LLM provider (e.g. anthropic)")
  .option("--model <id>", "Model id (e.g. claude-opus-4-7)")
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
      ...(concurrency !== undefined && Number.isFinite(concurrency)
        ? { concurrency }
        : {}),
      ...(pick("provider") !== undefined ? { provider: pick("provider")! } : {}),
      ...(pick("model") !== undefined ? { model: pick("model")! } : {}),
    });
    process.exit(code);
  });

cli
  .command(
    "db <action>",
    "DB maintenance: vacuum | gc-blobs | backup",
  )
  .option("--to <path>", "`backup` only: destination path")
  .option("--limit <n>", "`gc-blobs` only: max rows per pass (default 1000)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
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
      ...(pick("to") !== undefined ? { to: pick("to")! } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    process.exit(code);
  });

cli
  .command(
    "run <workflow>",
    "Upload a DOT workflow, enqueue a run, stream events to stdout",
  )
  .option("--url <url>", "Server URL (default http://localhost:3000)")
  .option("--priority <n>", "Priority tie-breaker (default 0)")
  .option("--no-follow", "Print the run id and exit without streaming")
  .option("--cwd <path>", "Base directory for relative workflow paths")
  .action(async (workflow: string, options: Record<string, unknown>) => {
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
    const code = await runCommand({
      workflow,
      ...(pick("url") !== undefined ? { url: pick("url")! } : {}),
      ...(priority !== undefined && Number.isFinite(priority) ? { priority } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
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

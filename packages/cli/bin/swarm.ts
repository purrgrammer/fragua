#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.

import cac from "cac";
import { listCommand } from "../src/commands/list.ts";
import { providersCommand } from "../src/commands/providers.ts";
import { replayCommand } from "../src/commands/replay.ts";
import { runCommand } from "../src/commands/run.ts";
import { steerCommand } from "../src/commands/steer.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

cli
  .command("run <workflow>", "Execute a workflow end-to-end")
  .option("--input <text>", "Prompt / argument passed to the pipeline")
  .option("--model <id>", "Override the default LLM model")
  .option("--provider <name>", "Override the default provider")
  .option("--run-id <id>", "Use a specific run id (default auto-generated)")
  .option("--runs-dir <path>", "Directory for event logs (default .swarm/runs)")
  .option("--cwd <path>", "Working directory for tools")
  .option("--mock", "Use the faux LLM provider (no scripted responses → most runs will fail)")
  .option("-v, --verbose", "Stream tool calls + LLM events as they happen (level 2)")
  .option("-q, --quiet", "Suppress per-node progress output (level 0)")
  .option("--allow-env-keys", "Bypass the .env secret scanner (use with caution)")
  .option("--worktree", "Run in an isolated git worktree (branch swarm/<run-id>)")
  .option("--keep-worktree", "Keep the worktree after the run for post-mortem (implies --worktree)")
  .option("--interviewer <mode>", "Human-in-the-loop interviewer: auto | console (default: console if TTY)")
  .action(async (workflow: string, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const code = await runCommand({
      workflow,
      ...(pick("input") !== undefined ? { input: pick("input")! } : {}),
      ...(pick("model") !== undefined ? { model: pick("model")! } : {}),
      ...(pick("provider") !== undefined ? { provider: pick("provider")! } : {}),
      ...(pick("run-id") !== undefined ? { runId: pick("run-id")! } : {}),
      ...(pick("runs-dir") !== undefined ? { runsDir: pick("runs-dir")! } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(options["mock"] === true ? { mock: true } : {}),
      ...(options["verbose"] === true
        ? { verbosity: 2 as const }
        : options["quiet"] === true
          ? { verbosity: 0 as const }
          : {}),
      ...(options["allow-env-keys"] === true ? { allowEnvKeys: true } : {}),
      ...(options["worktree"] === true ? { worktree: true } : {}),
      ...(options["keep-worktree"] === true ? { keepWorktree: true } : {}),
      ...(pick("interviewer") === "auto" || pick("interviewer") === "console"
        ? { interviewer: pick("interviewer") as "auto" | "console" }
        : {}),
    });
    process.exit(code);
  });

cli.command("validate <workflow>", "Parse + lint a workflow without executing").action(async (workflow: string) => {
  const code = await validateCommand(workflow);
  process.exit(code);
});

cli
  .command("replay <events>", "Print a summary of a run from its JSONL events file")
  .action(async (eventsPath: string) => {
    const code = await replayCommand(eventsPath);
    process.exit(code);
  });

cli.command("providers", "List supported LLM providers and which ones have credentials").action(() => {
  process.exit(providersCommand());
});

cli
  .command("steer <run-id> <message>", "Inject a steering message into a running swarm process")
  .option("--runs-dir <path>", "Runs directory (default .swarm/runs)")
  .option("--cwd <path>", "Base directory")
  .action(async (runId: string, message: string, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const code = await steerCommand({
      runId,
      message,
      ...(pick("runs-dir") !== undefined ? { runsDir: pick("runs-dir")! } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
    });
    process.exit(code);
  });

cli
  .command("list", "List recent runs with outcome + failed nodes")
  .option("--limit <n>", "How many recent runs to show (default 20)")
  .option("--runs-dir <path>", "Directory to scan (default .swarm/runs)")
  .action(async (options: Record<string, unknown>) => {
    const limitRaw = options["limit"];
    const runsDirRaw = options["runs-dir"];
    const code = await listCommand({
      ...(typeof limitRaw === "string" || typeof limitRaw === "number"
        ? { limit: Number.parseInt(String(limitRaw), 10) }
        : {}),
      ...(typeof runsDirRaw === "string" ? { runsDir: runsDirRaw } : {}),
    });
    process.exit(code);
  });

cli.help();
cli.version("0.0.0");
cli.parse();

#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.

import cac from "cac";
import { providersCommand } from "../src/commands/providers.ts";
import { replayCommand } from "../src/commands/replay.ts";
import { runCommand } from "../src/commands/run.ts";
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

cli.help();
cli.version("0.0.0");
cli.parse();

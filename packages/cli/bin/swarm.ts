#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.

import cac from "cac";
import { listCommand } from "../src/commands/list.ts";
import { providersCommand } from "../src/commands/providers.ts";
import { replayCommand } from "../src/commands/replay.ts";
import { runCommand } from "../src/commands/run.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { steerCommand } from "../src/commands/steer.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

cli
  .command("run <workflow>", "Execute a workflow end-to-end")
  .option("--input <text>", "Prompt / argument passed to the pipeline")
  .option(
    "--input-file <path>",
    "File whose contents become the input (repeatable; each file prefixed with `===== <path> =====`)",
  )
  .option(
    "--model <id>",
    "Model id (e.g. `claude-opus-4-7` for anthropic, `anthropic/claude-opus-4.7` for openrouter). Defaults per provider; see `swarm providers`.",
  )
  .option(
    "--provider <name>",
    "Inference provider / API endpoint: anthropic | openai | openrouter | google | groq | cerebras | xai | mistral | vercel-ai-gateway | github-copilot | amazon-bedrock | google-vertex",
  )
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
    const pickArray = (key: string): string[] | undefined => {
      const v = options[key];
      if (typeof v === "string") return [v];
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
      return undefined;
    };
    // cac camelCases hyphenated flags: `--input-file` lands on `options.inputFile`.
    // Reading `options["input-file"]` returns undefined and silently drops the flag.
    const code = await runCommand({
      workflow,
      ...(pick("input") !== undefined ? { input: pick("input")! } : {}),
      ...(pickArray("inputFile") !== undefined ? { inputFiles: pickArray("inputFile")! } : {}),
      ...(pick("model") !== undefined ? { model: pick("model")! } : {}),
      ...(pick("provider") !== undefined ? { provider: pick("provider")! } : {}),
      ...(pick("runId") !== undefined ? { runId: pick("runId")! } : {}),
      ...(pick("runsDir") !== undefined ? { runsDir: pick("runsDir")! } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(options["mock"] === true ? { mock: true } : {}),
      ...(options["verbose"] === true
        ? { verbosity: 2 as const }
        : options["quiet"] === true
          ? { verbosity: 0 as const }
          : {}),
      ...(options["allowEnvKeys"] === true ? { allowEnvKeys: true } : {}),
      ...(options["worktree"] === true ? { worktree: true } : {}),
      ...(options["keepWorktree"] === true ? { keepWorktree: true } : {}),
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

cli
  .command("serve", "Start the HTTP + SSE server in the foreground (Ctrl-C to stop)")
  .option("--port <n>", "TCP port to bind (default 3000; pass 0 for ephemeral)")
  .option("--runs-dir <path>", "Runs directory to expose (default .swarm/runs)")
  .option("--cwd <path>", "Base directory for resolving --runs-dir")
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
      ...(pick("runs-dir") !== undefined ? { runsDir: pick("runs-dir")! } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
    });
    process.exit(code);
  });

cli.help();
cli.version("0.0.0");
cli.parse();

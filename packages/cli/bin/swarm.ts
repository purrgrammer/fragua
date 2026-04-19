#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.
//
// Commands that depended on the legacy fs-based control plane (run, daemon,
// pause, cancel, steer, resume, list, dashboard) were removed in the
// rearchitecture. They will be reintroduced in M5 as thin shells over the
// HTTP intent routes once the store-backed runtime is the default.

import cac from "cac";
import chalk from "chalk";
import { providersCommand } from "../src/commands/providers.ts";
import { replayCommand } from "../src/commands/replay.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

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

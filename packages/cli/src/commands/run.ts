// `swarm run <workflow.dot>` — execute a workflow end-to-end.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createPiMockBackend, getProviderInfo, hasProviderCredentials, PiCodergenBackend } from "@swarm/agent";
import type { CodergenBackend } from "@swarm/core";
import { execute, parseDotSource, validateOrThrow } from "@swarm/core";
import { JsonlSink } from "@swarm/events";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";

export interface RunCommandOptions {
  workflow: string;
  input?: string;
  runsDir?: string;
  /** Use the faux provider (no API calls) — requires scripted responses, rarely useful from CLI. */
  mock?: boolean;
  /** Override the initial model, e.g. claude-haiku-4-5. */
  model?: string;
  /** Override the provider, e.g. anthropic / openai / google. */
  provider?: string;
  runId?: string;
  /** Override the working directory. */
  cwd?: string;
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const absoluteWorkflow = resolve(opts.workflow);
  await stat(absoluteWorkflow); // throws if missing
  const source = await readFile(absoluteWorkflow, "utf8");
  const graph = parseDotSource(source);
  validateOrThrow(graph);

  const workflow_sha = createHash("sha256").update(source).digest("hex");
  const run_id = opts.runId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runsDir = opts.runsDir ?? ".swarm/runs";
  const eventsPath = resolve(opts.cwd ?? process.cwd(), runsDir, run_id, "events.jsonl");

  const env = new LocalEnvironment(opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  const registry = new ToolRegistry();
  registry.registerAll(CORE_TOOLS);

  let backend: CodergenBackend;
  let mockHandle: { dispose: () => void } | undefined;
  if (opts.mock) {
    const h = createPiMockBackend({ registry, env });
    mockHandle = h;
    backend = h.backend;
  } else {
    const provider = opts.provider ?? "anthropic";
    const model = opts.model ?? "claude-haiku-4-5";
    if (!hasProviderCredentials(provider)) {
      const info = getProviderInfo(provider);
      const hint = info
        ? `set one of: ${info.envVars.join(", ")}`
        : "unknown provider — check spelling or run `swarm providers` to list supported ones";
      console.error(chalk.red(`no credentials found for provider "${provider}" — ${hint}`));
      return 2;
    }
    backend = new PiCodergenBackend({ registry, env, defaultModel: { provider, model } });
  }

  const sink = new JsonlSink({ filePath: eventsPath });

  console.log(chalk.bold(`swarm run ${absoluteWorkflow}`));
  console.log(chalk.dim(`  run_id: ${run_id}`));
  console.log(chalk.dim(`  events: ${eventsPath}`));
  console.log(chalk.dim(`  sha:    ${workflow_sha.slice(0, 12)}`));

  try {
    const res = await execute({
      graph,
      workflow_sha,
      run_id,
      sink,
      backend,
      initial_context: opts.input !== undefined ? { $ARGUMENTS: opts.input, input: opts.input } : {},
    });

    console.log(
      chalk[res.outcome.status === "success" ? "green" : "red"](
        `\n${res.outcome.status.toUpperCase()}: ${res.outcome.notes || res.outcome.failure_reason || ""}`,
      ),
    );
    if (res.outcome.status === "fail") return 1;
    return 0;
  } finally {
    await sink.close();
    mockHandle?.dispose();
  }
}

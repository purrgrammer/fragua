// `swarm run <workflow.dot>` — execute a workflow end-to-end.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createPiMockBackend, getProviderInfo, hasProviderCredentials, PiCodergenBackend } from "@swarm/agent";
import type { CodergenBackend } from "@swarm/core";
import { execute, parseDotSource, validateOrThrow } from "@swarm/core";
import { ConsoleSink, JsonlSink } from "@swarm/events";
import { CORE_TOOLS, formatLeaks, LocalEnvironment, scanDotenv, ToolRegistry } from "@swarm/workspace";
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
  /** Log detail: 0=quiet, 1=default (node-level), 2=verbose (tool calls + LLM). */
  verbosity?: 0 | 1 | 2;
  /** Bypass the .env secret-scanning gate. */
  allowEnvKeys?: boolean;
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const absoluteWorkflow = resolve(opts.workflow);
  await stat(absoluteWorkflow); // throws if missing
  const source = await readFile(absoluteWorkflow, "utf8");
  const graph = parseDotSource(source);
  validateOrThrow(graph);

  // Env-leak gate: scan ./.env in the target cwd before giving an agent keys.
  if (!opts.allowEnvKeys && !opts.mock) {
    const cwd = opts.cwd ?? process.cwd();
    const envPath = resolve(cwd, ".env");
    try {
      const envContents = await readFile(envPath, "utf8");
      const leaks = scanDotenv(envContents);
      if (leaks.length > 0) {
        console.error(chalk.red(formatLeaks(leaks)));
        return 3;
      }
    } catch {
      // no .env → nothing to scan
    }
  }

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

  const jsonl = new JsonlSink({ filePath: eventsPath });
  const sink = new ConsoleSink({ inner: jsonl, level: opts.verbosity ?? 1 });

  console.log(chalk.bold(`swarm run ${absoluteWorkflow}`));
  console.log(chalk.dim(`  run_id: ${run_id}`));
  console.log(chalk.dim(`  events: ${eventsPath}`));
  console.log(chalk.dim(`  sha:    ${workflow_sha.slice(0, 12)}`));
  console.log("");

  try {
    const res = await execute({
      graph,
      workflow_sha,
      run_id,
      sink,
      backend,
      initial_context: opts.input !== undefined ? { $ARGUMENTS: opts.input, input: opts.input } : {},
    });

    console.log("");
    if (res.outcome.status === "success") {
      console.log(chalk.green(`SUCCESS: ${res.outcome.notes || ""}`));
      return 0;
    }
    // Summarize failed nodes
    const failures = Object.entries(res.node_outcomes)
      .filter(([, o]) => o.status === "fail")
      .map(([id, o]) => ({ id, reason: o.failure_reason ?? o.notes ?? "" }));
    const reason = res.outcome.failure_reason ?? res.outcome.notes ?? "unknown failure";
    console.log(chalk.red(`FAIL: ${reason}`));
    if (failures.length > 0) {
      console.log(chalk.red("\nFailed nodes:"));
      for (const f of failures) {
        console.log(chalk.red(`  ${f.id} — ${f.reason.slice(0, 200)}`));
      }
    }
    console.log(chalk.dim(`\nReplay: bun run packages/cli/bin/swarm.ts replay ${eventsPath}`));
    return 1;
  } finally {
    await sink.close();
    mockHandle?.dispose();
  }
}

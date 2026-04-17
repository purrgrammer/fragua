// `swarm run <workflow.dot>` — execute a workflow end-to-end.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPiMockBackend, getProviderInfo, hasProviderCredentials, PiCodergenBackend } from "@swarm/agent";
import type { CodergenBackend } from "@swarm/core";
import { execute, parseDotSource, validateOrThrow } from "@swarm/core";
import { ConsoleSink, JsonlSink } from "@swarm/events";
import type { ExecutionEnvironment } from "@swarm/workspace";
import {
  CORE_TOOLS,
  formatLeaks,
  LocalEnvironment,
  scanDotenv,
  ToolRegistry,
  WorktreeEnvironment,
} from "@swarm/workspace";
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
  /** Run in an isolated git worktree (branch swarm/<run-id>). */
  worktree?: boolean;
  /** Don't delete the worktree after the run (for post-mortem). Implies --worktree. */
  keepWorktree?: boolean;
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

  const useWorktree = opts.worktree === true || opts.keepWorktree === true;
  let env: ExecutionEnvironment;
  let worktree: WorktreeEnvironment | undefined;
  if (useWorktree) {
    worktree = new WorktreeEnvironment({
      ...(opts.cwd !== undefined ? { repoRoot: opts.cwd } : {}),
      runId: run_id,
      ...(opts.keepWorktree === true ? { keepAfterDispose: true } : {}),
    });
    await worktree.init();
    env = worktree;
  } else {
    env = new LocalEnvironment(opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  }
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
  if (worktree) {
    console.log(chalk.dim(`  worktree: ${worktree.worktreePath}`));
    console.log(chalk.dim(`  branch:   ${worktree.branch}`));
  }
  console.log("");

  const startedAt = Date.now();
  try {
    const res = await execute({
      graph,
      workflow_sha,
      run_id,
      sink,
      backend,
      initial_context: opts.input !== undefined ? { $ARGUMENTS: opts.input, input: opts.input } : {},
    });
    const durationMs = Date.now() - startedAt;

    await writeRunSummary({
      summaryPath: resolve(dirname(eventsPath), "summary.md"),
      run_id,
      workflow: absoluteWorkflow,
      workflow_sha,
      input: opts.input,
      provider: opts.provider ?? "anthropic",
      model: opts.model ?? "claude-haiku-4-5",
      mock: opts.mock === true,
      worktree_path: worktree?.worktreePath,
      branch: worktree?.branch,
      result: res,
      durationMs,
    });

    console.log("");
    if (res.outcome.status === "success") {
      console.log(chalk.green(`SUCCESS: ${res.outcome.notes || ""}`));
      console.log(chalk.dim(`  summary: ${dirname(eventsPath)}/summary.md`));
      return 0;
    }
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
    console.log(chalk.dim(`\nReplay:  bun run packages/cli/bin/swarm.ts replay ${eventsPath}`));
    console.log(chalk.dim(`Summary: ${dirname(eventsPath)}/summary.md`));
    return 1;
  } finally {
    await sink.close();
    mockHandle?.dispose();
    if (worktree) await worktree.dispose();
  }
}

interface SummaryArgs {
  summaryPath: string;
  run_id: string;
  workflow: string;
  workflow_sha: string;
  input: string | undefined;
  provider: string;
  model: string;
  mock: boolean;
  worktree_path: string | undefined;
  branch: string | undefined;
  result: Awaited<ReturnType<typeof execute>>;
  durationMs: number;
}

async function writeRunSummary(args: SummaryArgs): Promise<void> {
  const lines: string[] = [];
  lines.push(`# swarm run ${args.run_id}`);
  lines.push("");
  lines.push(`- **status:** \`${args.result.outcome.status}\``);
  lines.push(`- **duration:** ${(args.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- **workflow:** ${args.workflow} (sha \`${args.workflow_sha.slice(0, 12)}\`)`);
  lines.push(`- **provider:** ${args.mock ? "mock (pi-ai faux)" : `${args.provider}/${args.model}`}`);
  if (args.input !== undefined) lines.push(`- **input:** \`${args.input}\``);
  if (args.worktree_path !== undefined) {
    lines.push(`- **worktree:** \`${args.worktree_path}\``);
    lines.push(`- **branch:** \`${args.branch}\``);
  }
  lines.push(`- **nodes completed:** ${args.result.completed_nodes.length}`);
  lines.push(`- **goal gates satisfied:** ${args.result.goal_gates_satisfied}`);
  lines.push("");

  if (args.result.outcome.status !== "success" && args.result.outcome.failure_reason) {
    lines.push(`## Failure reason`);
    lines.push("");
    lines.push(`> ${args.result.outcome.failure_reason}`);
    lines.push("");
  }

  const failures = Object.entries(args.result.node_outcomes).filter(([, o]) => o.status === "fail");
  if (failures.length > 0) {
    lines.push(`## Failed nodes`);
    lines.push("");
    for (const [id, o] of failures) {
      const reason = o.failure_reason ?? o.notes ?? "";
      lines.push(`- \`${id}\` — ${reason.slice(0, 400)}`);
    }
    lines.push("");
  }

  lines.push(`## Node timeline`);
  lines.push("");
  lines.push("| # | node | status | notes |");
  lines.push("|---|---|---|---|");
  args.result.completed_nodes.forEach((id, i) => {
    const o = args.result.node_outcomes[id];
    const status = o?.status ?? "?";
    const note = ((o?.failure_reason ?? o?.notes ?? "") as string).replace(/\|/g, "\\|").slice(0, 120);
    lines.push(`| ${i + 1} | \`${id}\` | ${status} | ${note} |`);
  });
  lines.push("");

  lines.push(`## Debugging`);
  lines.push("");
  lines.push(`- Events: \`${dirname(args.summaryPath)}/events.jsonl\``);
  lines.push(`- Replay: \`bun run packages/cli/bin/swarm.ts replay ${dirname(args.summaryPath)}/events.jsonl\``);

  await mkdir(dirname(args.summaryPath), { recursive: true });
  await writeFile(args.summaryPath, `${lines.join("\n")}\n`, "utf8");
}

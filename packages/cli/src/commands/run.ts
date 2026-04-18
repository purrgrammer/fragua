// `swarm run <workflow.dot>` — execute a workflow end-to-end.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createPiMockBackend,
  createSubagentTool,
  defaultModelFor,
  defaultSummariserModel,
  getProviderInfo,
  hasProviderCredentials,
  PiCodergenBackend,
  PiSummariserBackend,
  resolveModelOrNull,
} from "@swarm/agent";
import type { CodergenBackend, Interviewer, SummariserBackend } from "@swarm/core";
import { AutoApproveInterviewer, ConsoleInterviewer, execute, parseDotSource, validateOrThrow } from "@swarm/core";
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
import { loadConfig } from "../config.ts";

export interface RunCommandOptions {
  workflow: string;
  input?: string;
  /** Files whose contents are concatenated into the input with `===== <path> =====` headers. */
  inputFiles?: string[];
  runsDir?: string;
  /** Use the faux provider (no API calls) — requires scripted responses, rarely useful from CLI. */
  mock?: boolean;
  /** Override the initial model, e.g. claude-opus-4-7. */
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
  /** Which interviewer to use for wait.human nodes. Default: console if stdin is a TTY, else auto. */
  interviewer?: "auto" | "console";
  /** Disable async pipeline title generation. Default: on when a
   * summariser is configured. Maps to `--no-auto-title`. */
  noAutoTitle?: boolean;
  /** Override the summariser provider (Wave 2b). Defaults to
   * `config.defaults.summariser.provider`. */
  summariserProvider?: string;
  /** Override the summariser model (Wave 2b). Defaults to
   * `config.defaults.summariser.model` then per-provider cheap tier. */
  summariserModel?: string;
}

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const config = await loadConfig(cwd);

  const absoluteWorkflow = resolve(opts.workflow);
  await stat(absoluteWorkflow); // throws if missing
  const source = await readFile(absoluteWorkflow, "utf8");
  const graph = parseDotSource(source);
  validateOrThrow(graph);

  // Merge --input with --input-file contents. Raw --input goes first; each file
  // follows as `===== <path> =====\n<content>` so the model can cite sources.
  const mergedInput = await buildMergedInput(opts);
  if (mergedInput === "error") return 1;

  // Env-leak gate: scan ./.env in the target cwd before giving an agent keys.
  if (!opts.allowEnvKeys && !opts.mock) {
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
  const runsDir = opts.runsDir ?? config.project?.runs_dir ?? ".swarm/runs";
  const eventsPath = resolve(cwd, runsDir, run_id, "events.jsonl");

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
  let summariser: SummariserBackend | undefined;
  if (opts.mock) {
    const h = createPiMockBackend({ registry, env });
    mockHandle = h;
    backend = h.backend;
  } else {
    // Priority: CLI flag > .swarm/config.yaml > per-provider default > hard default.
    const provider = opts.provider ?? config.defaults?.provider ?? "anthropic";
    const info = getProviderInfo(provider);
    const model = opts.model ?? config.defaults?.model ?? defaultModelFor(provider) ?? "claude-opus-4-7";
    if (!hasProviderCredentials(provider)) {
      const hint = info
        ? `set one of: ${info.envVars.join(", ")}`
        : "unknown provider — check spelling or run `swarm providers` to list supported ones";
      console.error(chalk.red(`no credentials found for provider "${provider}" — ${hint}`));
      return 2;
    }
    // Preflight: fail fast if (provider, model) doesn't resolve in pi-ai,
    // rather than letting every node retry the same unresolvable model.
    if (resolveModelOrNull(provider, model) === null) {
      console.error(chalk.red(`model "${provider}/${model}" is not in pi-ai's registry.`));
      if (info?.exampleModels && info.exampleModels.length > 0) {
        console.error(chalk.dim(`  valid ${provider} models include:`));
        for (const m of info.exampleModels) console.error(chalk.dim(`    ${m}`));
      }
      console.error(
        chalk.dim(
          `  Note: aggregator providers (openrouter / vercel-ai-gateway / bedrock / vertex) use namespaced ids like "anthropic/claude-haiku-4.5". Direct providers (anthropic / openai / google) use bare ids like "claude-haiku-4-5".`,
        ),
      );
      return 2;
    }
    // Summariser wiring: explicit flags win, then `.swarm/config.yaml`
    // `defaults.summariser`, then the coder's provider with that
    // provider's cheap-tier default model. When no credentials are
    // available, `summariser` stays undefined — auto-title and
    // summary:medium/high simply don't fire (fidelity=summary:* emits a
    // soft agent.warning and falls back to summary:low's deterministic
    // template, matching Wave 2).
    const sumProvider = opts.summariserProvider ?? config.defaults?.summariser?.provider ?? provider;
    const sumModel =
      opts.summariserModel ??
      config.defaults?.summariser?.model ??
      defaultSummariserModel(sumProvider) ??
      defaultModelFor(sumProvider);
    if (sumModel && hasProviderCredentials(sumProvider) && resolveModelOrNull(sumProvider, sumModel) !== null) {
      summariser = new PiSummariserBackend({ provider: sumProvider, model: sumModel });
    }

    backend = new PiCodergenBackend({
      registry,
      env,
      defaultModel: { provider, model },
      runsDir: resolve(opts.cwd ?? process.cwd(), runsDir),
      ...(summariser !== undefined ? { summariser } : {}),
    });
    registry.register(createSubagentTool({ registry, env, defaultModel: { provider, model } }));
  }

  const interviewerChoice = opts.interviewer ?? (process.stdin.isTTY && !opts.mock ? "console" : "auto");
  const interviewer: Interviewer =
    interviewerChoice === "console" ? new ConsoleInterviewer() : new AutoApproveInterviewer();

  const jsonl = new JsonlSink({ filePath: eventsPath });
  const console_sink = new ConsoleSink({ inner: jsonl, level: opts.verbosity ?? 1 });
  const sink = console_sink;

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
      workflow_path: opts.workflow,
      workflow_source: source,
      run_id,
      sink,
      backend,
      interviewer,
      // `$ARGUMENTS` is read via prompt substitution's `args` channel, not
      // the context map. We also mirror into context.input so prompts that
      // read `${context.input}` continue to work.
      ...(mergedInput !== undefined ? { args: { $ARGUMENTS: mergedInput } } : {}),
      initial_context: mergedInput !== undefined ? { input: mergedInput } : {},
      ...(summariser !== undefined ? { summariser } : {}),
      // --no-auto-title hard-disables, otherwise config/graph take over.
      ...(opts.noAutoTitle === true ? { auto_title: "off" as const } : {}),
      ...(opts.noAutoTitle !== true && config.auto_title === "off" ? { auto_title: "off" as const } : {}),
    });
    const durationMs = Date.now() - startedAt;

    await writeRunSummary({
      summaryPath: resolve(dirname(eventsPath), "summary.md"),
      run_id,
      workflow: absoluteWorkflow,
      workflow_sha,
      input: mergedInput,
      provider: opts.provider ?? "anthropic",
      model: opts.model ?? "claude-opus-4-7",
      mock: opts.mock === true,
      worktree_path: worktree?.worktreePath,
      branch: worktree?.branch,
      result: res,
      durationMs,
      cost: console_sink.totals,
    });

    console.log("");
    const t = console_sink.totals;
    if (t.calls > 0) {
      console.log(
        chalk.dim(
          `cost: $${t.cost_usd.toFixed(4)} · ${t.calls} LLM call${t.calls === 1 ? "" : "s"} · ${t.input_tokens}in / ${t.output_tokens}out tokens`,
        ),
      );
    }
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
  cost: { cost_usd: number; input_tokens: number; output_tokens: number; calls: number };
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
  if (args.cost.calls > 0) {
    lines.push(
      `- **cost:** $${args.cost.cost_usd.toFixed(4)} across ${args.cost.calls} LLM call${
        args.cost.calls === 1 ? "" : "s"
      } (${args.cost.input_tokens} in / ${args.cost.output_tokens} out tokens)`,
    );
  }
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

/** Combine --input and --input-file(s). Files are prefixed with `===== <path> =====`
 * so the model can cite the source. Returns the merged string, `undefined` if both
 * were empty, or `"error"` if a file failed to load (caller should exit 1). */
export async function buildMergedInput(opts: RunCommandOptions): Promise<string | undefined | "error"> {
  const files = opts.inputFiles ?? [];
  if (opts.input === undefined && files.length === 0) return undefined;

  const parts: string[] = [];
  if (opts.input !== undefined) parts.push(opts.input);

  const cwd = opts.cwd ?? process.cwd();
  for (const path of files) {
    const abs = resolve(cwd, path);
    try {
      const body = await readFile(abs, "utf8");
      parts.push(`===== ${path} =====\n${body}`);
    } catch (err) {
      console.error(
        chalk.red(`--input-file: cannot read "${path}": ${err instanceof Error ? err.message : String(err)}`),
      );
      return "error";
    }
  }
  return parts.join("\n\n");
}

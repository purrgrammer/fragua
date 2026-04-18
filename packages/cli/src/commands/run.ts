// `swarm run <workflow.dot>` — execute a workflow end-to-end.

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import type { CheckpointStore, CodergenBackend, Interviewer, SummariserBackend } from "@swarm/core";
import { AutoApproveInterviewer, ConsoleInterviewer, execute, parseDotSource, validateOrThrow } from "@swarm/core";
import { ConsoleSink, JsonlCheckpointStore, JsonlSink, tailControlRequests } from "@swarm/events";
import type { ExecutionEnvironment } from "@swarm/workspace";
import {
  CORE_TOOLS,
  discoverSkills,
  formatLeaks,
  LocalEnvironment,
  scanDotenv,
  ToolRegistry,
  WorktreeEnvironment,
} from "@swarm/workspace";
import chalk from "chalk";
import { ensureDaemonRunning } from "../lib/daemon-client.ts";
import { loadConfig } from "../config.ts";

export interface RunCommandOptions {
  workflow: string;
  input?: string;
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
  /** Run in an isolated git worktree (branch swarm/<run-id>). Default true. */
  worktree?: boolean;
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
  /** Wave 6: resume from the most recent checkpoint for `runId`. No-op
   * when the checkpoint file is missing, so the same flag works for
   * fresh runs (a new checkpoint gets written as the run progresses).
   * Pair with `--run-id <original-id>` to target a specific earlier
   * run; without it the generated id won't match any checkpoint. */
  resume?: boolean;
  /** Wave 6: disable checkpoint writes. Off by default outside of
   * `--mock` so `--resume` on a later invocation has something to
   * load. */
  noCheckpoint?: boolean;
  /** When set, `runCommand` refuses to auto-start the daemon and
   * exits non-zero if one isn't already running. Useful for CI. */
  noAutostart?: boolean;
}

/**
 * Top-level dispatcher.
 *
 * - If `SWARM_WORKER_JOB_ID` is set in the env, the daemon's supervisor
 *   spawned us — run the workflow in-process (original behaviour).
 * - Otherwise this is a user-invoked `swarm run` → POST `/jobs` and
 *   return. Fire-and-forget: no streaming, no waiting on exit.
 */
export async function runCommand(opts: RunCommandOptions): Promise<number> {
  if (process.env["SWARM_WORKER_JOB_ID"]) {
    return runCommandInProcess(opts);
  }
  return runCommandViaDaemon(opts);
}

/**
 * In-process execution. The daemon's `ProcessSupervisor` sets
 * `SWARM_WORKER_JOB_ID` when it spawns us so we take this path instead
 * of recursing through `POST /jobs`. Still exported for tests that
 * want to drive the executor directly.
 */
export async function runCommandInProcess(opts: RunCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const config = await loadConfig(cwd);

  const absoluteWorkflow = resolve(opts.workflow);
  await stat(absoluteWorkflow); // throws if missing
  const source = await readFile(absoluteWorkflow, "utf8");
  const graph = parseDotSource(source);
  validateOrThrow(graph);

  const mergedInput = opts.input;

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
  const controlPath = resolve(cwd, runsDir, run_id, "control.jsonl");

  // Worktree defaults to true for daemon-spawned workers; in-process
  // direct calls (tests, debugging) can pass false to skip the git
  // dance. The CLI layer already collapses `--no-worktree` to
  // `opts.worktree === false` so we only disable on that exact value.
  const useWorktree = opts.worktree !== false;
  let env: ExecutionEnvironment;
  let worktree: WorktreeEnvironment | undefined;
  if (useWorktree) {
    worktree = new WorktreeEnvironment({
      ...(opts.cwd !== undefined ? { repoRoot: opts.cwd } : {}),
      runId: run_id,
    });
    await worktree.init();
    env = worktree;
  } else {
    env = new LocalEnvironment(opts.cwd !== undefined ? { cwd: opts.cwd } : {});
  }
  const registry = new ToolRegistry();
  registry.registerAll(CORE_TOOLS);

  // Skill discovery runs once per CLI invocation against the run's cwd +
  // the user's home directory. Matching catalog advertisement and the
  // scoped `local:load_skill` tool happen per-node inside the backend,
  // which lets node-level `skills=…` / `skills_disabled` override which
  // entries the model sees without rebuilding the registry.
  const { skills: discoveredSkills, warnings: skillWarnings } = await discoverSkills({
    cwd,
    homeDir: homedir(),
    ...(config.skills !== undefined ? { config: config.skills } : {}),
  });
  for (const msg of skillWarnings) console.error(chalk.dim(`skills: ${msg}`));

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
      ...(summariser !== undefined ? { summariser } : {}),
      ...(discoveredSkills.length > 0 ? { skills: discoveredSkills } : {}),
    });
    registry.register(
      createSubagentTool({
        registry,
        env,
        defaultModel: { provider, model },
        ...(discoveredSkills.length > 0 ? { skills: discoveredSkills } : {}),
      }),
    );
  }

  const interviewerChoice = opts.interviewer ?? (process.stdin.isTTY && !opts.mock ? "console" : "auto");
  const interviewer: Interviewer =
    interviewerChoice === "console" ? new ConsoleInterviewer() : new AutoApproveInterviewer();

  const jsonl = new JsonlSink({ filePath: eventsPath });
  const console_sink = new ConsoleSink({ inner: jsonl, level: opts.verbosity ?? 1 });
  const sink = console_sink;

  // Wave 6 checkpoint plumbing. Always on outside of --mock and
  // --no-checkpoint so a later `swarm run --resume --run-id <id>` has
  // something to load. Stored alongside events.jsonl under the same
  // run directory.
  const checkpointStore: CheckpointStore | undefined =
    opts.mock || opts.noCheckpoint === true ? undefined : new JsonlCheckpointStore({ runsDir: resolve(cwd, runsDir) });
  if (opts.resume === true && opts.runId === undefined) {
    console.warn(
      chalk.yellow(
        "  --resume is set but --run-id wasn't — a fresh id was generated, so there's no checkpoint to load. Pass the original run id to resume an earlier crashed run.",
      ),
    );
  }

  console.log(chalk.bold(`swarm run ${absoluteWorkflow}`));
  console.log(chalk.dim(`  run_id: ${run_id}${opts.resume ? " (resume)" : ""}`));
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
      ...(checkpointStore !== undefined ? { checkpointStore } : {}),
      ...(opts.resume === true ? { resume: true as const } : {}),
      controlChannel: {
        path: controlPath,
        tail: tailControlRequests,
      },
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
      const cacheSuffix =
        t.cache_read_tokens > 0 || t.cache_write_tokens > 0
          ? ` · cache ${t.cache_read_tokens}r / ${t.cache_write_tokens}w`
          : "";
      console.log(
        chalk.dim(
          `cost: $${t.cost_usd.toFixed(4)} · ${t.calls} LLM call${t.calls === 1 ? "" : "s"} · ${t.input_tokens}in / ${t.output_tokens}out tokens${cacheSuffix}`,
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
  cost: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    calls: number;
  };
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
    const cacheSuffix =
      args.cost.cache_read_tokens > 0 || args.cost.cache_write_tokens > 0
        ? `, cache ${args.cost.cache_read_tokens} read / ${args.cost.cache_write_tokens} write`
        : "";
    lines.push(
      `- **cost:** $${args.cost.cost_usd.toFixed(4)} across ${args.cost.calls} LLM call${
        args.cost.calls === 1 ? "" : "s"
      } (${args.cost.input_tokens} in / ${args.cost.output_tokens} out tokens${cacheSuffix})`,
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

// ---------------------------------------------------------------------------
// Daemon-client path — user-invoked `swarm run`.
//
// Fire-and-forget: the daemon owns execution, writes events.jsonl, and
// surfaces progress via the web UI. We just POST /jobs, print the
// identifiers, and exit 0. Nothing to stream. Nothing to wait on.
// ---------------------------------------------------------------------------

interface EnqueueBody {
  workflow: string;
  input?: string;
  model?: string;
  runId?: string;
  worktree?: boolean;
}

export async function runCommandViaDaemon(opts: RunCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();

  // Resolve workflow to an absolute path before POSTing so the daemon
  // can find it regardless of its own cwd.
  const absoluteWorkflow = resolve(cwd, opts.workflow);
  try {
    await stat(absoluteWorkflow);
  } catch {
    console.error(chalk.red(`run: workflow not found: ${opts.workflow}`));
    return 1;
  }

  const daemon = await ensureDaemonRunning({
    cwd,
    autostart: opts.noAutostart !== true,
  });
  if (!daemon.ok) {
    console.error(chalk.red(`run: ${daemon.message}`));
    return 1;
  }

  const body: EnqueueBody = { workflow: absoluteWorkflow };
  if (opts.input !== undefined) body.input = opts.input;
  if (opts.model !== undefined) body.model = opts.model;
  if (opts.runId !== undefined) body.runId = opts.runId;
  // Forward the client's worktree preference. Omit when undefined to
  // accept the server-side default (worktree=true).
  if (opts.worktree === false) body.worktree = false;

  let res: Response;
  try {
    res = await fetch(`${daemon.baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(chalk.red(`run: POST /jobs failed — ${(err as Error).message}`));
    return 1;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(chalk.red(`run: POST /jobs → ${res.status} ${res.statusText}`));
    if (text) console.error(chalk.dim(`  ${text}`));
    return 1;
  }

  const payload = (await res.json()) as { jobId: string; runId: string };
  console.log(chalk.green(`queued: ${payload.jobId}`));
  console.log(chalk.dim(`  run:  ${payload.runId}`));
  console.log(chalk.dim(`  view: ${daemon.baseUrl}/pipelines/${payload.runId}`));
  return 0;
}


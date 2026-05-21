#!/usr/bin/env bun
// swarm CLI entry — dispatches subcommands.
//
// Commands that depended on the legacy fs-based control plane (run, daemon,
// pause, cancel, steer, resume, list, dashboard) were removed in the
// rearchitecture. They will be reintroduced in M5 as thin shells over the
// HTTP intent routes once the store-backed runtime is the default.

import cac from "cac";
import chalk from "chalk";
import { daemonCommand, daemonStopCommand } from "../src/commands/daemon.ts";
import { dbCommand } from "../src/commands/db.ts";
import { gcCommand, parseDuration } from "../src/commands/gc.ts";
import { harnessCommand } from "../src/commands/harness.ts";
import { initCommand } from "../src/commands/init.ts";
import {
  branchCommand,
  cancelCommand,
  commitCommand,
  diffCommand,
  discardCommand,
  inboxCommand,
  lsCommand,
  mergeCommand,
  respondCommand,
  resumeCommand,
  unquarantineCommand,
} from "../src/commands/operator.ts";
import {
  providersAddCommand,
  providersAddCustomCommand,
  providersAddModelCommand,
  providersEditModelCommand,
  providersHelpCommand,
  providersListCommand,
  providersLoginCommand,
  providersLogoutCommand,
  providersLsModelsCommand,
  providersRmCommand,
  providersRmModelCommand,
  providersTestCommand,
} from "../src/commands/providers.ts";
import type { ModelOpsFlags } from "../src/commands/providers-custom.ts";
import { resolveInputArgs, runCommand } from "../src/commands/run.ts";
import {
  scheduleHelp,
  scheduleListCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleRmCommand,
} from "../src/commands/schedule.ts";
import { serveCommand } from "../src/commands/serve.ts";
import { validateCommand } from "../src/commands/validate.ts";

const cli = cac("swarm");

// Translate cac's option bag into the per-model-ops flag shape.
// cac kebab-cases multi-word options: `--context-window` → `contextWindow`.
function parseModelOpsFlags(options: Record<string, unknown>): ModelOpsFlags {
  const pickStr = (key: string): string | undefined => {
    const v = options[key];
    return typeof v === "string" ? v : undefined;
  };
  const pickNum = (key: string): number | undefined => {
    const v = options[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  const out: ModelOpsFlags = {};
  const name = pickStr("name");
  if (name !== undefined) out.name = name;
  const ctx = pickNum("contextWindow");
  if (ctx !== undefined) out.contextWindow = ctx;
  const max = pickNum("maxTokens");
  if (max !== undefined) out.maxTokens = max;
  if (options["reasoning"] === true) out.reasoning = true;
  const input = pickStr("input");
  if (input !== undefined) {
    const parts = input
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const valid = parts.every((p) => p === "text" || p === "image");
    if (valid) out.input = parts as ("text" | "image")[];
  }
  const costIn = pickNum("costInput");
  if (costIn !== undefined) out.costInput = costIn;
  const costOut = pickNum("costOutput");
  if (costOut !== undefined) out.costOutput = costOut;
  if (options["yes"] === true) out.yes = true;
  return out;
}

cli.command("validate <workflow>", "Parse + lint a workflow without executing").action(async (workflow: string) => {
  const code = await validateCommand(workflow);
  process.exit(code);
});

cli
  .command("init", "Initialize this directory as a swarm project (writes .swarm/config.yaml)")
  .option("--cwd <path>", "Project root (default process.cwd)")
  .action(async (options: Record<string, unknown>) => {
    const cwd = typeof options["cwd"] === "string" ? (options["cwd"] as string) : undefined;
    const code = await initCommand(cwd !== undefined ? { cwd } : {});
    process.exit(code);
  });

// `swarm providers [action]` — bare form prints subcommand help, per
// the "top-level commands without arguments should list options"
// convention. cac 6.x doesn't cleanly match multi-word commands
// (`swarm providers ls` fell through to the parent), so actions are
// dispatched via a positional.
cli
  .command(
    "providers [action] [target] [extra]",
    "Manage LLM provider credentials + custom models (run without args for help)",
  )
  .option("--custom", "`add` only: add a custom (OpenAI-compatible) provider to the global store")
  .option("--name <str>", "`add-model`/`edit-model` only: display name")
  .option("--context-window <n>", "`add-model`/`edit-model` only: context window in tokens")
  .option("--max-tokens <n>", "`add-model`/`edit-model` only: max output tokens")
  .option("--reasoning", "`add-model`/`edit-model` only: model supports reasoning mode")
  .option("--input <list>", "`add-model`/`edit-model` only: comma-sep modalities (text,image)")
  .option("--cost-input <usd>", "`add-model`/`edit-model` only: per-million-token input cost")
  .option("--cost-output <usd>", "`add-model`/`edit-model` only: per-million-token output cost")
  .option("--yes, -y", "`add-model`/`rm-model`/`edit-model`: skip the confirmation prompt")
  .action(
    async (
      action: string | undefined,
      target: string | undefined,
      extra: string | undefined,
      options: Record<string, unknown>,
    ) => {
      switch (action) {
        case undefined:
          process.exit(providersHelpCommand());
          break;
        case "ls":
          process.exit(providersListCommand());
          break;
        case "add":
          if (options["custom"]) {
            process.exit(await providersAddCustomCommand());
          } else {
            process.exit(await providersAddCommand(target));
          }
          break;
        case "rm":
          process.exit(await providersRmCommand(target));
          break;
        case "test":
          process.exit(await providersTestCommand(target, extra));
          break;
        case "login":
          process.exit(await providersLoginCommand(target));
          break;
        case "logout":
          process.exit(await providersLogoutCommand(target));
          break;
        case "ls-models":
          if (target == null) {
            console.error(chalk.red("providers ls-models: <provider> required"));
            process.exit(1);
          }
          process.exit(await providersLsModelsCommand(target));
          break;
        case "add-model": {
          if (target == null || extra == null) {
            console.error(chalk.red("providers add-model: <provider> <id> required"));
            process.exit(1);
          }
          process.exit(await providersAddModelCommand(target, extra, parseModelOpsFlags(options)));
          break;
        }
        case "rm-model": {
          if (target == null || extra == null) {
            console.error(chalk.red("providers rm-model: <provider> <id> required"));
            process.exit(1);
          }
          const yes = options["yes"] === true;
          process.exit(await providersRmModelCommand(target, extra, yes ? { yes: true } : {}));
          break;
        }
        case "edit-model": {
          if (target == null || extra == null) {
            console.error(chalk.red("providers edit-model: <provider> <id> required"));
            process.exit(1);
          }
          process.exit(await providersEditModelCommand(target, extra, parseModelOpsFlags(options)));
          break;
        }
        default:
          console.error(chalk.red(`unknown providers action: ${action}`));
          providersHelpCommand();
          process.exit(1);
      }
    },
  );

cli
  .command("harness", "Supervise the daemon + HTTP server as a foreground process (Ctrl-C to stop)")
  .option("--port <n>", "TCP port for HTTP (default 6767, configurable via web.port in ~/.swarm/config.yaml)")
  .option("--db <path>", "Store path (default ~/.swarm/swarm.db)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const portRaw = options["port"];
    const portNum =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : undefined;
    const code = await harnessCommand({
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(portNum !== undefined && Number.isFinite(portNum) ? { port: portNum } : {}),
    });
    process.exit(code);
  });

cli
  .command("serve", "Start the HTTP + SSE server in the foreground (Ctrl-C to stop)")
  .option("--port <n>", "TCP port to bind (default 6767, configurable via web.port; writes <db-dir>/serve.json)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db); enables parallel swarms")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    const portRaw = options["port"];
    const portNum =
      typeof portRaw === "number" ? portRaw : typeof portRaw === "string" ? Number.parseInt(portRaw, 10) : undefined;
    const portExplicit = portNum !== undefined && Number.isFinite(portNum);
    const code = await serveCommand({
      // `port` left undefined when the user didn't pass `--port`, so
      // startServer resolves it via config.web.port → DEFAULT_WEB_PORT.
      // The URL is also published to <db-dir>/serve.json for discovery.
      ...(portExplicit ? { port: portNum! } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
    });
    process.exit(code);
  });

// `swarm daemon [action]` — bare form prints help; `start` runs the
// daemon foreground; `stop` SIGTERMs the process holding the store
// lock. cac 6.x doesn't cleanly match multi-word commands so actions
// are dispatched via a positional (same pattern as providers / db).
cli
  .command("daemon [action]", "Run or stop the execution daemon (run without args for help)")
  .option("--concurrency <n>", "`start` only: max concurrent runs (default 16)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .option("--provider <name>", "`start` only: LLM provider override (default: auto-detected)")
  .option("--model <id>", "`start` only: model id override (e.g. claude-opus-4-7)")
  .action(async (action: string | undefined, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    if (action === undefined) {
      console.log(chalk.bold("swarm daemon — run or stop the execution daemon\n"));
      console.log("Subcommands:");
      console.log(`  ${chalk.cyan("start")}    Run the store-backed daemon in the foreground (Ctrl-C to stop)`);
      console.log(`  ${chalk.cyan("stop")}     SIGTERM the running daemon identified by the store's daemon_lock`);
      process.exit(0);
    }
    if (action === "stop") {
      const code = await daemonStopCommand({
        ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
        ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      });
      process.exit(code);
    }
    if (action === "start") {
      const concurrencyRaw = options["concurrency"];
      const concurrency =
        typeof concurrencyRaw === "number"
          ? concurrencyRaw
          : typeof concurrencyRaw === "string"
            ? Number.parseInt(concurrencyRaw, 10)
            : undefined;
      const code = await daemonCommand({
        ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
        ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
        ...(concurrency !== undefined && Number.isFinite(concurrency) ? { concurrency } : {}),
        ...(pick("provider") !== undefined ? { provider: pick("provider")! } : {}),
        ...(pick("model") !== undefined ? { model: pick("model")! } : {}),
      });
      process.exit(code);
    }
    console.error(chalk.red(`unknown daemon action: ${action}`));
    console.error(chalk.dim("  valid actions: start | stop"));
    process.exit(1);
  });

cli
  .command("gc", "Garbage-collect run artefacts")
  .option("--snapshots", "Reclaim worktree snapshot refs for settled runs past the retention window")
  .option("--older-than <duration>", "Retention window (e.g. 30d, 12h, 2w). Default 30d.")
  .option("--dry-run", "Report what would be deleted without touching anything")
  .option("--cwd <path>", "Repo root (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
  .action(async (options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    if (options["snapshots"] !== true) {
      console.error(chalk.red("gc: --snapshots is required (no other targets supported yet)"));
      process.exit(1);
    }
    let olderThanMs: number;
    try {
      olderThanMs = parseDuration(pick("olderThan"));
    } catch (err) {
      console.error(chalk.red(`gc: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
    const code = await gcCommand({
      target: "snapshots",
      olderThanMs,
      ...(options["dryRun"] === true ? { dryRun: true } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
    });
    process.exit(code);
  });

cli
  .command("db <action>", "DB maintenance: vacuum | gc-blobs | backup")
  .option("--to <path>", "`backup` only: destination path")
  .option("--limit <n>", "`gc-blobs` only: max rows per pass (default 1000)")
  .option("--cwd <path>", "Base directory (default process.cwd)")
  .option("--db <path>", "Store path (default <cwd>/.swarm/swarm.db)")
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
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(pick("to") !== undefined ? { to: pick("to")! } : {}),
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    });
    process.exit(code);
  });

cli
  .command(
    "run <workflow>",
    "Upload a workflow, enqueue a run, stream events to stdout. " +
      "Pass workflow inputs with --input name=value (repeatable); set an " +
      "explicit run title with --title (otherwise the title is auto-summarised). " +
      "Add --every <interval> to create a recurring schedule instead of a one-shot run.",
  )
  .option("--url <url>", "Server URL (default: discovered via serve.json, else localhost:3000)")
  .option(
    "-i, --input <name=value>",
    "Run input; repeat for multiple (one name=value each). Value @path reads a file, @- reads stdin (e.g. --input task=@spec.md)",
  )
  .option("--title <text>", "Explicit run title (skips auto-titling)")
  .option("--priority <n>", "Priority tie-breaker (default 0)")
  .option("--no-follow", "Print the run id and exit without streaming")
  .option("--cwd <path>", "Base directory for relative workflow paths")
  .option("--db <path>", "Store path; discovers server at <dirname(db)>/serve.json")
  .option("--every <interval>", "Create a recurring schedule: 30m | 1h | 6h | 24h | 3d | 7d (skips streaming)")
  .option(
    "--on-overlap <policy>",
    "Schedule overlap policy: skip | queue | concurrent (default skip; only with --every)",
  )
  .option("--no-fire-on-create", "Wait one full interval before the first fire (only with --every)")
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
    // --input name=value (repeatable). cac yields a string for one flag,
    // an array for several. Each must contain '='; a value of @path / @-
    // is sourced from a file / stdin (resolveInputArgs).
    let inputs: Record<string, string> = {};
    try {
      inputs = await resolveInputArgs(options["input"] as string | string[] | undefined);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    const code = await runCommand({
      workflow,
      ...(pick("url") !== undefined ? { url: pick("url")! } : {}),
      ...(priority !== undefined && Number.isFinite(priority) ? { priority } : {}),
      ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
      ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
      ...(pick("title") !== undefined ? { title: pick("title")! } : {}),
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
      // cac renders `--no-follow` as `options.follow === false`.
      ...(options["follow"] === false ? { follow: false } : {}),
      // Schedule creation path (--every present).
      ...(pick("every") !== undefined ? { every: pick("every")! } : {}),
      ...(pick("onOverlap") !== undefined ? { onOverlap: pick("onOverlap")! } : {}),
      // cac renders `--no-fire-on-create` as `options.fireOnCreate === false`.
      ...(options["fireOnCreate"] === false ? { noFireOnCreate: true } : {}),
    });
    process.exit(code);
  });

// `swarm runs <verb> <runId>` — operate on an existing run. Disposition
// (branch/commit/merge/discard/diff) + lifecycle (respond/resume/
// unquarantine/cancel) + listing (ls/inbox). `swarm run <workflow>`
// (singular) creates a run; `swarm runs` (plural) acts on one.
const pickStr = (options: Record<string, unknown>, key: string): string | undefined => {
  const v = options[key];
  return typeof v === "string" ? v : undefined;
};
const discovery = (options: Record<string, unknown>): { url?: string; cwd?: string; dbPath?: string } => ({
  ...(pickStr(options, "url") !== undefined ? { url: pickStr(options, "url")! } : {}),
  ...(pickStr(options, "cwd") !== undefined ? { cwd: pickStr(options, "cwd")! } : {}),
  ...(pickStr(options, "db") !== undefined ? { dbPath: pickStr(options, "db")! } : {}),
});

function runsHelp(): void {
  console.log(`swarm runs <verb> <runId> — operate on an existing run

  Disposition (terminal runs with recoverable work):
    branch <id> <name> [--force]      promote committed history to a branch
    commit <id> -m <msg> [--onto <b>] commit the full tree onto a branch (default base ref)
    merge  <id> [--no-ff|--squash] [--into <b>]  merge committed history (ff default)
    discard <id>                      drop the run's swarm refs
    diff   <id> [--against <ref>] [--snap <idx>]  print the snapshot diff

  Lifecycle (blocked runs):
    respond <id> [route] [--note <t>] answer a HITL gate (interactive without a route)
    resume  <id> [--note <t>]         wake a paused run
    unquarantine <id> --resolution treat_as_done|retry|cancel
    cancel  <id> [--reason <t>]

  Listing:
    inbox                             runs needing attention (2 sections)
    ls [--status a,b] [--limit N]     list runs`);
}

cli
  .command("runs [action] [runId] [arg]", "Operate on an existing run (run without args for help)")
  .option("--force", "branch: overwrite an existing branch")
  .option("-m, --message <msg>", "commit: message")
  .option("--onto <branch>", "commit: target branch (default: the run's base ref)")
  .option("--no-ff", "merge: create a merge commit instead of fast-forwarding")
  .option("--squash", "merge: squash the run's history into one commit")
  .option("--into <branch>", "merge: target branch (default: the run's base ref)")
  .option("--against <ref>", "diff: base | previous | <eventIdx> (default base)")
  .option("--snap <eventIdx>", "diff: snapshot to show (default: latest)")
  .option("--route <route>", "respond: HITL route (omit for interactive)")
  .option("--note <text>", "respond/resume/unquarantine: optional note")
  .option("--reason <text>", "cancel: optional reason")
  .option("--resolution <r>", "unquarantine: treat_as_done | retry | cancel")
  .option("--status <list>", "ls: comma-separated lifecycle statuses")
  .option("--limit <n>", "ls/inbox: cap results")
  .option("--url <url>", "Server URL (default: discovered via serve.json or daemon_lock)")
  .option("--cwd <dir>", "Project root for server discovery")
  .option("--db <path>", "Store path; discovers server at <dirname(db)>/serve.json")
  .action(
    async (
      action: string | undefined,
      runId: string | undefined,
      arg: string | undefined,
      options: Record<string, unknown>,
    ) => {
      const limitRaw = options["limit"];
      const limit =
        typeof limitRaw === "number"
          ? limitRaw
          : typeof limitRaw === "string"
            ? Number.parseInt(limitRaw, 10)
            : undefined;
      const limitOpt = limit !== undefined && Number.isFinite(limit) ? { limit } : {};
      const needId = (): string => {
        if (runId == null) {
          console.error(chalk.red(`runs ${action}: <runId> required`));
          process.exit(1);
        }
        return runId;
      };
      switch (action) {
        case undefined:
          runsHelp();
          process.exit(0);
          break;
        case "inbox":
          process.exit(await inboxCommand({ ...limitOpt, ...discovery(options) }));
          break;
        case "ls":
          process.exit(
            await lsCommand({
              ...(pickStr(options, "status") !== undefined ? { status: pickStr(options, "status")! } : {}),
              ...limitOpt,
              ...discovery(options),
            }),
          );
          break;
        case "branch": {
          const id = needId();
          if (arg == null) {
            console.error(chalk.red("runs branch: <branch> name required"));
            process.exit(1);
          }
          process.exit(
            await branchCommand({
              runId: id,
              branch: arg,
              ...(options["force"] === true ? { force: true } : {}),
              ...discovery(options),
            }),
          );
          break;
        }
        case "commit":
          process.exit(
            await commitCommand({
              runId: needId(),
              ...(pickStr(options, "message") !== undefined ? { message: pickStr(options, "message")! } : {}),
              ...(pickStr(options, "onto") !== undefined ? { onto: pickStr(options, "onto")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        case "merge":
          process.exit(
            await mergeCommand({
              runId: needId(),
              ...(options["ff"] === false ? { noFf: true } : {}),
              ...(options["squash"] === true ? { squash: true } : {}),
              ...(pickStr(options, "into") !== undefined ? { into: pickStr(options, "into")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        case "discard":
          process.exit(await discardCommand({ runId: needId(), ...discovery(options) }));
          break;
        case "diff": {
          const snapRaw = options["snap"];
          const snap =
            typeof snapRaw === "number"
              ? snapRaw
              : typeof snapRaw === "string"
                ? Number.parseInt(snapRaw, 10)
                : undefined;
          process.exit(
            await diffCommand({
              runId: needId(),
              ...(pickStr(options, "against") !== undefined ? { against: pickStr(options, "against")! } : {}),
              ...(snap !== undefined && Number.isFinite(snap) ? { snap } : {}),
              ...discovery(options),
            }),
          );
          break;
        }
        case "respond": {
          const route = pickStr(options, "route") ?? arg;
          process.exit(
            await respondCommand({
              runId: needId(),
              ...(route !== undefined ? { route } : {}),
              ...(pickStr(options, "note") !== undefined ? { note: pickStr(options, "note")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        }
        case "resume":
          process.exit(
            await resumeCommand({
              runId: needId(),
              ...(pickStr(options, "note") !== undefined ? { note: pickStr(options, "note")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        case "cancel":
          process.exit(
            await cancelCommand({
              runId: needId(),
              ...(pickStr(options, "reason") !== undefined ? { reason: pickStr(options, "reason")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        case "unquarantine":
          process.exit(
            await unquarantineCommand({
              runId: needId(),
              ...(pickStr(options, "resolution") !== undefined ? { resolution: pickStr(options, "resolution")! } : {}),
              ...(pickStr(options, "note") !== undefined ? { note: pickStr(options, "note")! } : {}),
              ...discovery(options),
            }),
          );
          break;
        default:
          console.error(chalk.red(`unknown runs action: ${action}`));
          runsHelp();
          process.exit(1);
      }
    },
  );

cli
  .command("schedules [action] [target]", "Manage recurring workflow runs (run without args for help)")
  .option("--cwd <dir>", "Project root / filter for `list`")
  .option("--url <url>", "Server URL (default: discovered via serve.json or daemon_lock)")
  .option("--db <path>", "Store path; discovers server at <dirname(db)>/serve.json")
  .action(async (action: string | undefined, target: string | undefined, options: Record<string, unknown>) => {
    const pick = (key: string): string | undefined => {
      const v = options[key];
      return typeof v === "string" ? v : undefined;
    };
    switch (action) {
      case undefined:
        process.exit(scheduleHelp());
        break;
      case "add":
        console.log(chalk.yellow("schedules add has moved — create a schedule with:"));
        console.log(
          chalk.cyan(
            "  swarm run <workflow> --every <30m|1h|6h|24h|3d|7d> [--on-overlap skip|queue|concurrent] [--no-fire-on-create]",
          ),
        );
        process.exit(0);
        break;
      case "list":
      case "ls": {
        const code = await scheduleListCommand({
          ...(pick("url") !== undefined ? { url: pick("url")! } : {}),
          ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
          ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
        });
        process.exit(code);
        break;
      }
      case "rm":
      case "pause":
      case "resume": {
        if (target == null) {
          console.error(chalk.red(`schedules ${action}: id required`));
          process.exit(1);
        }
        const idOpts = {
          id: target,
          ...(pick("url") !== undefined ? { url: pick("url")! } : {}),
          ...(pick("cwd") !== undefined ? { cwd: pick("cwd")! } : {}),
          ...(pick("db") !== undefined ? { dbPath: pick("db")! } : {}),
        };
        const code =
          action === "rm"
            ? await scheduleRmCommand(idOpts)
            : action === "pause"
              ? await schedulePauseCommand(idOpts)
              : await scheduleResumeCommand(idOpts);
        process.exit(code);
        break;
      }
      default:
        console.error(chalk.red(`unknown schedules action: ${action}`));
        scheduleHelp();
        process.exit(1);
    }
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

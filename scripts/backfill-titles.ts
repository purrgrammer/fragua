// One-off backfill: generate and append `pipeline.title_generated` events to
// `.swarm/runs/*/events.jsonl` entries that predate the Wave-2b auto-title.
// Reads the project config (`.swarm/config.yaml`) to pick the summariser
// provider + model. Credential-less? Script logs and exits cleanly.
//
// Sources for the pipeline input, in priority order:
//   1. `pipeline.started.data.input` (post-Wave-2b runs only)
//   2. First `llm.start.prompt` — strips any leading `<swarm-context>`
//      wrapper so the summariser sees the real user ask
//   3. Run's summary.md "input" field (older CLI path)
//
// Idempotent: skips runs that already have a `pipeline.title_generated`
// event and runs with no usable source text. Writes append-only — never
// rewrites existing lines.
//
// Usage:
//   bun run scripts/backfill-titles.ts [--runs-dir .swarm/runs] [--limit N] [--dry-run]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultSummariserModel, hasProviderCredentials, PiSummariserBackend, resolveModelOrNull } from "@swarm/agent";
import type { Event } from "@swarm/core";
import { EVENT_SCHEMA_VERSION, titleSyntheticNodeId } from "@swarm/core";
import YAML from "yaml";

interface Args {
  runsDir: string;
  limit: number | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runsDir: resolve(process.cwd(), ".swarm/runs"), limit: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs-dir" && argv[i + 1]) {
      args.runsDir = resolve(process.cwd(), argv[++i]!);
    } else if (a === "--limit" && argv[i + 1]) {
      args.limit = Number.parseInt(argv[++i]!, 10);
    } else if (a === "--dry-run") {
      args.dryRun = true;
    }
  }
  return args;
}

async function loadSummariserFromConfig(): Promise<
  { summariser: PiSummariserBackend; provider: string; model: string } | undefined
> {
  try {
    const body = await readFile(resolve(process.cwd(), ".swarm/config.yaml"), "utf8");
    const parsed = YAML.parse(body) as {
      defaults?: {
        provider?: string;
        summariser?: { provider?: string; model?: string };
      };
    } | null;
    const mainProvider = parsed?.defaults?.provider;
    const sumProvider = parsed?.defaults?.summariser?.provider ?? mainProvider ?? "anthropic";
    const sumModel = parsed?.defaults?.summariser?.model ?? defaultSummariserModel(sumProvider);
    if (!sumModel) {
      console.error(
        `no summariser model configured for provider "${sumProvider}" — set defaults.summariser in .swarm/config.yaml`,
      );
      return undefined;
    }
    if (!hasProviderCredentials(sumProvider)) {
      console.error(
        `no credentials for summariser provider "${sumProvider}" — set the relevant env var (e.g. OPENROUTER_API_KEY)`,
      );
      return undefined;
    }
    if (resolveModelOrNull(sumProvider, sumModel) === null) {
      console.error(`model "${sumProvider}/${sumModel}" not registered in pi-ai`);
      return undefined;
    }
    return {
      summariser: new PiSummariserBackend({ provider: sumProvider, model: sumModel }),
      provider: sumProvider,
      model: sumModel,
    };
  } catch (err) {
    console.error(`cannot load .swarm/config.yaml: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Parse a single run's events.jsonl into an array, skipping malformed lines. */
async function readEvents(file: string): Promise<Event[]> {
  const body = await readFile(file, "utf8");
  const events: Event[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as Event);
    } catch {
      // skip malformed
    }
  }
  return events;
}

/** Find the source text to title. Returns undefined when nothing usable.
 *
 * Priority:
 *   1. `pipeline.started.data.input` — post-Wave-2b canonical source
 *   2. `summary.md` `- **input:** \`…\`` line — the CLI has written this
 *      since P3; reliable for older runs that predate (1)
 *   3. First `llm.start.prompt`, with any `<swarm-context>` framing
 *      stripped — last-ditch for runs with neither of the above */
async function pickSourceText(runDir: string, events: Event[]): Promise<string | undefined> {
  for (const ev of events) {
    if (ev.type !== "pipeline.started") continue;
    const input = (ev.data as { input?: unknown }).input;
    if (typeof input === "string" && input.length > 0) return input;
    break;
  }
  try {
    const summary = await readFile(join(runDir, "summary.md"), "utf8");
    const line = /^-\s*\*\*input:\*\*\s*`([\s\S]*?)`\s*$/m.exec(summary);
    if (line?.[1] && line[1].length > 0) return line[1];
  } catch {
    // no summary.md — fall through
  }
  for (const ev of events) {
    if (ev.type !== "llm.start") continue;
    const prompt = (ev.data as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string" || prompt.length === 0) continue;
    const stripped = prompt.replace(/^<swarm-context[\s\S]*?<\/swarm-context>\s*/i, "").trim();
    return stripped.length > 0 ? stripped : prompt;
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sum = await loadSummariserFromConfig();
  if (!sum) {
    process.exitCode = 2;
    return;
  }
  console.log(`backfill-titles: using ${sum.provider}/${sum.model}; runs dir ${args.runsDir}`);

  let entries: string[];
  try {
    entries = (await readdir(args.runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    console.error(`cannot read runs dir: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }

  let patched = 0;
  let skipped = 0;
  for (const runId of entries) {
    if (args.limit !== undefined && patched >= args.limit) break;
    const file = join(args.runsDir, runId, "events.jsonl");
    let events: Event[];
    try {
      events = await readEvents(file);
    } catch {
      skipped++;
      continue;
    }
    if (events.length === 0) {
      skipped++;
      continue;
    }
    if (events.some((e) => e.type === "pipeline.title_generated")) {
      skipped++;
      continue;
    }
    const source = await pickSourceText(join(args.runsDir, runId), events);
    if (!source) {
      skipped++;
      continue;
    }
    const workflow_sha = events[0]?.workflow_sha ?? "";
    const synthetic = titleSyntheticNodeId();
    const goalRaw = (events[0]?.data as { goal?: unknown } | undefined)?.goal;
    const goal = typeof goalRaw === "string" && goalRaw.length > 0 ? goalRaw : undefined;
    // dry-run skips the LLM call entirely so users can preview which runs
    // would be processed without spending tokens.
    if (args.dryRun) {
      const preview = source.replace(/\s+/g, " ").trim().slice(0, 70);
      console.log(`dry-run ${runId}: would title from input → "${preview}${source.length > 70 ? "…" : ""}"`);
      patched++;
      continue;
    }
    const result = await sum.summariser.summarise({
      purpose: "title",
      input: source,
      ...(goal !== undefined ? { goal } : {}),
      run_id: runId,
      workflow_sha,
      synthetic_node_id: synthetic,
      max_output_tokens: 40,
    });
    if (!result.ok || result.text.length === 0) {
      console.warn(`skip ${runId}: summariser ${result.error ?? "produced no text"}`);
      skipped++;
      continue;
    }
    const title = result.text.replace(/^["']|["']$/g, "").trim();
    const now = new Date().toISOString();
    const evt: Event = {
      run_id: runId,
      node_id: synthetic,
      type: "pipeline.title_generated",
      timestamp: now,
      workflow_sha,
      schema_version: EVENT_SCHEMA_VERSION,
      data: { title, summary_node_id: synthetic, backfilled: true },
    };
    await writeFile(file, `${(await readFile(file, "utf8")).trimEnd()}\n${JSON.stringify(evt)}\n`, "utf8");
    console.log(`patched ${runId}: ${title}`);
    patched++;
  }

  console.log(`backfill-titles: patched ${patched}, skipped ${skipped}${args.dryRun ? " (dry run)" : ""}`);
}

await main();

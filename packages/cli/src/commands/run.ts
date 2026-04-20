// `swarm run <workflow.dot>` — enqueue a run via HTTP and stream events.
//
//   1. Read the DOT file.
//   2. POST /workflows to register it and receive the sha.
//   3. POST /runs with that sha (+ any routing/priority).
//   4. Stream /runs/:id/stream (SSE) to stdout until the run reaches a
//      terminal state or the user hits Ctrl-C.
//
// Assumes a daemon is already serving the HTTP surface — start it with
// `swarm daemon` + `swarm serve`.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

async function discoverServerUrl(searchPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(searchPath, "utf8");
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

export interface RunCommandOptions {
  workflow: string;
  /** Base URL of the running server. When omitted, reads `.swarm/serve.json`
   * (written by `swarm serve`), then falls back to `http://localhost:3000`. */
  url?: string;
  /** Priority tie-breaker. Higher runs first. Default 0. */
  priority?: number;
  /** Starting routing entries injected into run_state.routing. */
  routing?: Record<string, unknown>;
  /** Exit after the run enters a terminal state. Default true. */
  follow?: boolean;
  /** Base directory used to resolve relative workflow paths. Default cwd. */
  cwd?: string;
  /** Store path. When set, discovers the server URL at `<dirname(db)>/serve.json`
   * instead of `<cwd>/.swarm/serve.json`. Pairs with `swarm serve --db`. */
  dbPath?: string;
}

const TERMINAL_TYPES = new Set<string>([
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_paused_hitl",
  "fact.run_quarantined",
]);

export async function runCommand(opts: RunCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const discoveryPath = opts.dbPath
    ? resolve(dirname(resolve(opts.dbPath)), "serve.json")
    : resolve(cwd, ".swarm/serve.json");
  const resolvedUrl = opts.url ?? (await discoverServerUrl(discoveryPath)) ?? "http://localhost:3000";
  const baseUrl = resolvedUrl.replace(/\/$/, "");
  const dotPath = resolve(cwd, opts.workflow);
  const name = basename(opts.workflow);

  let dotSource: string;
  try {
    dotSource = await readFile(dotPath, "utf8");
  } catch (err) {
    console.error(chalk.red(`run: cannot read ${dotPath}: ${(err as Error).message}`));
    return 1;
  }

  // 1. Upload workflow
  const uploadRes = await postJson(`${baseUrl}/workflows`, {
    name,
    dotSource,
  });
  if (!uploadRes.ok) {
    return fail(`upload failed (${uploadRes.status})`, uploadRes);
  }
  const { sha } = (await uploadRes.json()) as { sha: string };
  console.log(chalk.dim(`workflow ${name} -> ${sha.slice(0, 12)}`));

  // 2. Enqueue run
  const enqueueBody: Record<string, unknown> = { workflowSha: sha };
  if (opts.priority !== undefined) enqueueBody["priority"] = opts.priority;
  if (opts.routing !== undefined) enqueueBody["routing"] = opts.routing;
  const enqueueRes = await postJson(`${baseUrl}/runs`, enqueueBody);
  if (!enqueueRes.ok) {
    return fail(`enqueue failed (${enqueueRes.status})`, enqueueRes);
  }
  const { runId } = (await enqueueRes.json()) as { runId: string };
  console.log(chalk.green(`run queued: ${runId}`));

  if (opts.follow === false) return 0;

  // 3. Stream events
  const streamRes = await fetch(`${baseUrl}/runs/${runId}/stream`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!streamRes.ok || streamRes.body == null) {
    console.error(chalk.red(`stream failed (${streamRes.status})`));
    return 1;
  }

  let exit = 0;
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const sep = buf.indexOf("\n\n");
      if (sep < 0) break;
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const parsed = parseSSE(frame);
      if (parsed == null) continue;
      renderEvent(parsed);
      if (TERMINAL_TYPES.has(parsed.type)) {
        if (parsed.type === "fact.run_halted") exit = 1;
        if (parsed.type === "fact.run_cancelled") exit = 130;
        if (parsed.type === "fact.run_paused_hitl") {
          console.log(chalk.yellow("run paused for HITL input — exiting."));
        }
        break outer;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return exit;
}

interface SSEEvent {
  id?: string;
  type: string;
  data: unknown;
}

function parseSSE(frame: string): SSEEvent | null {
  const lines = frame.split("\n");
  let id: string | undefined;
  let type = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (data.length === 0) return null;
  try {
    return id !== undefined ? { id, type, data: JSON.parse(data) } : { type, data: JSON.parse(data) };
  } catch {
    return { type, data };
  }
}

function renderEvent(event: SSEEvent): void {
  const payload = event.data as { seq?: number; payload?: unknown };
  const seq = payload.seq ?? event.id ?? "-";
  const color = event.type.startsWith("fact.run_completed")
    ? chalk.green
    : event.type.startsWith("fact.run_halted") || event.type.startsWith("fact.run_cancelled")
      ? chalk.red
      : event.type.startsWith("intent.")
        ? chalk.blue
        : chalk.dim;
  console.log(`${chalk.dim(`[${seq}]`)} ${color(event.type)} ${JSON.stringify(payload.payload ?? {})}`);
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fail(msg: string, res: Response): Promise<number> {
  console.error(chalk.red(`run: ${msg}`));
  try {
    console.error(chalk.dim(`  ${await res.text()}`));
  } catch {}
  return 1;
}

function basename(p: string): string {
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const leaf = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

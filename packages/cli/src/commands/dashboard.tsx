// `swarm dashboard [--run-id <id>]` — Ink TUI for a running swarm pipeline.
//
// Layout:
//
//   ┌──────────────────────────────────────────┐
//   │  ASCII graph (active node highlighted)    │
//   ├──────────────────────────────────────────┤
//   │  ▶ running │ $0.0421 │ 3.2k in / 1.1k out │  ← CostBar
//   ├──────────────────────────────────────────┤
//   │  stream of events (rolling window)        │
//   └──────────────────────────────────────────┘
//   [s] steer  [a] abort  [q] quit
//
// Data flow:
//   1. Resolve run id (--run-id wins; else newest dir under runs).
//   2. `readJsonlEvents` — load existing events to seed state + graph.
//   3. `tailJsonl` — stream appends. One AbortController unwinds
//      everything when the user hits `q`.
//   4. Keypresses go through `dispatchKey`; `s` opens a prompt, `a`
//      submits a `control.cancel` request, `q` exits.
//
// We keep React state minimal: the tail loop maintains its own Maps and
// calls a `bump` setter on each event to force re-render (React doesn't
// track Map mutations). This avoids cloning the event log on every
// append — important for long runs with thousands of events.

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Event, Graph } from "@swarm/core";
import { parseDotSource } from "@swarm/core";
import {
  accumulateCost,
  type CostTotals,
  emptyCostTotals,
  readJsonlEvents,
  submitControlRequest,
  tailJsonl,
} from "@swarm/events";
import chalk from "chalk";
import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AsciiGraph } from "../ui/AsciiGraph.tsx";
import { CostBar } from "../ui/CostBar.tsx";
import { formatEventLine } from "../ui/format-event.ts";
import { dispatchKey } from "../ui/KeyHandler.ts";
import { activeNodeId, buildNodeStates, foldNodeState, type NodeStateRecord } from "../ui/node-state.ts";
import type { StreamLine } from "../ui/StreamPane.tsx";
import { StreamPane } from "../ui/StreamPane.tsx";

export interface DashboardCommandOptions {
  runId?: string;
  runsDir?: string;
  /** Tail new events as they arrive (default true). Pass false to print a
   * one-shot snapshot and exit — useful in tests / CI. */
  follow?: boolean;
  cwd?: string;
}

export async function dashboardCommand(opts: DashboardCommandOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const runsDir = resolve(cwd, opts.runsDir ?? ".swarm/runs");
  const follow = opts.follow !== false;

  // 1. Resolve run id.
  let runId: string;
  try {
    runId = opts.runId ?? (await newestRunId(runsDir));
  } catch (err) {
    console.error(chalk.red(`dashboard: ${(err as Error).message}`));
    return 1;
  }
  const runDir = resolve(runsDir, runId);
  try {
    const s = await stat(runDir);
    if (!s.isDirectory()) throw new Error(`${runDir} is not a directory`);
  } catch {
    console.error(chalk.red(`dashboard: run "${runId}" not found at ${runDir}`));
    return 1;
  }

  const eventsPath = resolve(runDir, "events.jsonl");
  const controlPath = resolve(runDir, "control.jsonl");

  // 2. Seed with existing events.
  let initialEvents: Event[] = [];
  try {
    initialEvents = await readJsonlEvents(eventsPath);
  } catch {
    // File may not exist yet (pipeline just started). Empty is fine.
  }

  // Non-TTY mode: print a one-shot snapshot to stdout and exit.
  // Useful for CI / piping and keeps the code path exercised even when
  // Ink can't attach to a real terminal.
  if (!process.stdout.isTTY || follow === false) {
    printSnapshot(runId, initialEvents);
    return 0;
  }

  const { waitUntilExit } = render(
    <DashboardApp runId={runId} eventsPath={eventsPath} controlPath={controlPath} initialEvents={initialEvents} />,
    { exitOnCtrlC: false }, // we own Ctrl-C via dispatchKey
  );
  await waitUntilExit();
  return 0;
}

/** Pick the newest (most-recently-modified) run directory under `runsDir`. */
async function newestRunId(runsDir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    throw new Error(`no runs found in ${runsDir} (pass --run-id to target a specific run)`);
  }
  const candidates: Array<{ id: string; mtime: number }> = [];
  for (const id of entries) {
    try {
      const s = await stat(resolve(runsDir, id));
      if (s.isDirectory()) candidates.push({ id, mtime: s.mtimeMs });
    } catch {
      // skip unreadable entries
    }
  }
  if (candidates.length === 0) {
    throw new Error(`no runs found in ${runsDir} (pass --run-id to target a specific run)`);
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]!.id;
}

/** Fallback path when stdout is not a TTY — print a human summary. */
function printSnapshot(runId: string, events: Event[]): void {
  const states = buildNodeStates(events);
  const totals = emptyCostTotals();
  for (const ev of events) accumulateCost(totals, ev);
  const status = inferStatus(events);
  console.log(chalk.bold(`dashboard — ${runId}`));
  console.log(`  status: ${status}`);
  console.log(`  cost:   $${totals.cost_usd.toFixed(4)}`);
  console.log(`  tokens: ${totals.input_tokens} in / ${totals.output_tokens} out`);
  console.log(`  nodes:  ${states.size}`);
  const active = activeNodeId(states);
  if (active) console.log(`  active: ${active}`);
  console.log(chalk.dim("  (non-TTY: launch from a real terminal for the live Ink UI)"));
}

function inferStatus(events: readonly Event[]): "running" | "completed" | "failed" | "canceled" | "pending" {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "pipeline.completed") return "completed";
    if (e.type === "pipeline.failed") return "failed";
    if (e.type === "pipeline.canceled") return "canceled";
  }
  return events.length > 0 ? "running" : "pending";
}

// ─────────────────────────────────────────────────────────────────────────
// Ink App
// ─────────────────────────────────────────────────────────────────────────

interface DashboardAppProps {
  runId: string;
  eventsPath: string;
  controlPath: string;
  initialEvents: Event[];
}

type Mode = "idle" | "steering" | "confirming-abort";

const MAX_STREAM_LINES = 200;

function DashboardApp(props: DashboardAppProps): JSX.Element {
  const { runId, eventsPath, controlPath, initialEvents } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Mutable refs that outlive renders — we fold events into these maps
  // and bump a counter on each append to trigger React updates.
  const nodeStatesRef = useRef<Map<string, NodeStateRecord>>(new Map());
  const costRef = useRef<CostTotals>(emptyCostTotals());
  const streamRef = useRef<StreamLine[]>([]);
  const seqRef = useRef(0);
  const lastActivityRef = useRef<string | undefined>(undefined);
  const statusRef = useRef<"running" | "completed" | "failed" | "canceled" | "pending">("pending");
  const graphRef = useRef<Graph | null>(null);

  const [, setBump] = useState(0);
  const [mode, setMode] = useState<Mode>("idle");
  const [steerBuffer, setSteerBuffer] = useState("");
  const [flash, setFlash] = useState<string | null>(null);

  // Seed state from initial events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: initialEvents is a one-shot seed; re-seeding would double-count.
  useEffect(() => {
    for (const ev of initialEvents) ingestEvent(ev);
    setBump((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start the tail after the seed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ingestEvent closes over stable refs; including it triggers unnecessary re-subscribes.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        for await (const ev of tailJsonl(eventsPath, { signal: ac.signal, includeExisting: false })) {
          // Skip any events already in the seed — tailJsonl opens at current EOF
          // when includeExisting=false, so this is just belt-and-braces.
          ingestEvent(ev);
          setBump((x) => x + 1);
        }
      } catch {
        // The tail loop is deliberately forgiving; unreachable file, abort, etc.
        // all fall through to here and end the stream quietly.
      }
    })();
    return () => ac.abort();
  }, [eventsPath]);

  function ingestEvent(ev: Event): void {
    seqRef.current += 1;
    foldNodeState(nodeStatesRef.current, ev, seqRef.current);
    accumulateCost(costRef.current, ev);
    if (ev.timestamp) lastActivityRef.current = ev.timestamp;
    // Update status.
    if (ev.type === "pipeline.started") statusRef.current = "running";
    else if (ev.type === "pipeline.completed") statusRef.current = "completed";
    else if (ev.type === "pipeline.failed") statusRef.current = "failed";
    else if (ev.type === "pipeline.canceled") statusRef.current = "canceled";
    // Capture workflow DOT on the first pipeline.started.
    if (ev.type === "pipeline.started" && graphRef.current === null) {
      const src = (ev.data as { workflow_source?: unknown } | undefined)?.workflow_source;
      if (typeof src === "string" && src.length > 0) {
        try {
          graphRef.current = parseDotSource(src);
        } catch {
          // Malformed DOT — leave null so the UI shows a placeholder.
        }
      }
    }
    // Push a stream line.
    const sl = formatEventLine(ev);
    if (sl) {
      streamRef.current.push(sl);
      if (streamRef.current.length > MAX_STREAM_LINES) {
        streamRef.current.splice(0, streamRef.current.length - MAX_STREAM_LINES);
      }
    }
  }

  const onSteer = useCallback(() => setMode("steering"), []);
  const onAbort = useCallback(() => setMode("confirming-abort"), []);
  const onQuit = useCallback(() => exit(), [exit]);

  // Main keybinds: only active in idle mode. Sub-modes take over input.
  useInput((input, key) => {
    if (mode === "idle") {
      dispatchKey(input, key, { onSteer, onAbort, onQuit });
      return;
    }
    if (mode === "steering") {
      if (key.escape === true) {
        setMode("idle");
        setSteerBuffer("");
        return;
      }
      if (key.return === true) {
        const msg = steerBuffer.trim();
        if (msg.length > 0) {
          submitControlRequest(controlPath, "steer", { message: msg })
            .then(() => setFlash(`steered: ${msg.slice(0, 60)}`))
            .catch((err: unknown) => setFlash(`steer failed: ${describeError(err)}`));
        }
        setMode("idle");
        setSteerBuffer("");
        return;
      }
      if (key.backspace === true || key.delete === true) {
        setSteerBuffer((s) => s.slice(0, -1));
        return;
      }
      if (!key.ctrl && !key.meta && input && input.length > 0) {
        setSteerBuffer((s) => s + input);
      }
      return;
    }
    if (mode === "confirming-abort") {
      if (input.toLowerCase() === "y") {
        submitControlRequest(controlPath, "cancel", { reason: "dashboard abort" })
          .then(() => setFlash("abort requested"))
          .catch((err: unknown) => setFlash(`abort failed: ${describeError(err)}`));
        setMode("idle");
        return;
      }
      if (input.toLowerCase() === "n" || key.escape === true) {
        setMode("idle");
        return;
      }
    }
  });

  const graph = graphRef.current;
  const nodeStates = nodeStatesRef.current;
  const active = activeNodeId(nodeStates) ?? null;

  const termHeight = stdout?.rows ?? 40;
  const termWidth = stdout?.columns ?? 120;

  // Reserve ~4 rows for the status + cost bar + prompt, give the rest to
  // graph and stream roughly 50/50.
  const chrome = 5;
  const available = Math.max(8, termHeight - chrome);
  const streamHeight = Math.min(20, Math.max(4, Math.floor(available * 0.4)));
  void termWidth; // reserved for future horizontal clipping

  const totals = costRef.current;
  const status = statusRef.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: streamRef.current.length IS the tracked input — we snapshot the ring buffer whenever it grows.
  const streamLines = useMemo(() => streamRef.current.slice(), [streamRef.current.length]);

  return (
    <Box flexDirection="column">
      {/* Graph pane */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>workflow</Text>
        {graph ? (
          <AsciiGraph graph={graph} nodeStates={nodeStates} activeNodeId={active} />
        ) : (
          <Text dimColor>(waiting for pipeline.started — the DOT source is recorded on the first event)</Text>
        )}
      </Box>

      {/* Cost + status */}
      <Box paddingX={1} paddingY={0}>
        <CostBar
          totals={totals}
          status={status}
          runId={runId}
          {...(lastActivityRef.current !== undefined ? { lastActivity: lastActivityRef.current } : {})}
        />
      </Box>

      {/* Stream pane */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text bold>events</Text>
        <StreamPane lines={streamLines} height={streamHeight} />
      </Box>

      {/* Footer / mode-dependent prompt */}
      <Box paddingX={1}>
        {mode === "idle" ? (
          <Text dimColor>
            [s] steer [a] abort [q] quit
            {flash !== null ? `  │  ${flash}` : ""}
          </Text>
        ) : null}
        {mode === "steering" ? (
          <Text>
            <Text color="yellow">steer » </Text>
            <Text>{steerBuffer}</Text>
            <Text inverse>▌</Text>
            <Text dimColor> (Enter to send, Esc to cancel)</Text>
          </Text>
        ) : null}
        {mode === "confirming-abort" ? <Text color="red">abort this run? [y/N]</Text> : null}
      </Box>
    </Box>
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

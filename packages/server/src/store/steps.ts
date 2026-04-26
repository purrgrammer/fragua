// Pure reducer: StoredEvent[] → StepSnapshot[].
//
// A "step" is one `llm.start` event (one backend.run() call). Companion
// events fold onto the step opened at that llm.start until the next
// llm.start for the same nodeId starts a new one:
//   - `llm.text_delta` → appended to `finalText`.
//   - `llm.done`       → records endedAt / durationMs / stopReason. We do
//                        NOT close the step here: tool-using turns emit
//                        multiple message_end events under one llm.start,
//                        each with its own `done`, and a premature close
//                        would drop their `cost.recorded`s on the floor.
//   - `cost.recorded`  → DELIBERATELY NOT folded here. Cost / token
//                        SUMS are aggregated in SQL via
//                        `IEventStore.getStepAggregates()`. The route
//                        merges those aggregates onto these snapshots
//                        keyed by `startSeq`. SQL is the single source
//                        of truth for numerical totals; folding events
//                        in TS quietly mis-counted whenever the window
//                        model didn't match the agent's actual flow.
//
// Reads from the store's `StoredEvent` shape: `payload` is the event
// body (stamped with `nodeId` + `iteration` by the daemon's executor),
// `ts` is an epoch-ms number we render as ISO. Typed loosely as
// `StepEvent` so observability events (llm.start, llm.text_delta — not
// in the fact/intent union) are statically-valid input without casts at
// every call site.

export interface StepEvent {
  type: string;
  payload: unknown;
  ts: number;
  /** Stream sequence number of the event. Used to key SQL aggregates back
   * onto these snapshots; required on `llm.start` events. */
  seq?: number;
}

export interface StepSnapshot {
  /** 0-based index within the run, by stream order. Stable across refetches. */
  stepIdx: number;
  /** Stream seq of the originating `llm.start`. Joins with the SQL
   * aggregate row for this step (`getStepAggregates(runId)`). */
  startSeq: number;
  /** Real DOT node id (or a synthetic id for summariser steps). */
  nodeId: string;
  /** Iteration metadata when the caller is a loop. */
  iteration?: { n: number; max: number };
  /** ISO timestamp of the originating `llm.start`. */
  startedAt: string;
  /** ISO of the LAST `llm.done` in this step's window. */
  endedAt?: string;
  durationMs?: number;
  // ---- what the agent was asked ----
  provider?: string;
  model?: string;
  threadId?: string;
  fidelity?: string;
  /** Fully-substituted user prompt (the message the LLM saw). */
  prompt: string;
  /** System prompt assembled for this call. */
  systemPrompt: string;
  allowedTools: string[];
  deniedTools: string[];
  settings?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    reasoning_effort?: string;
    stop?: string[];
  };
  messages: Array<{ role: string; content?: unknown; timestamp?: number }>;
  contextFiles: Array<{
    path: string;
    sha256: string;
    bytes: number;
    truncated: boolean;
    status: string;
    error?: string;
  }>;
  skills: Array<{
    name: string;
    location: string;
    sha256: string;
    bytes: number;
    scope: "project" | "user";
    source_dir: string;
  }>;
  budget?: {
    cumulative_cost_usd: number;
    cumulative_tokens: number;
    max_cost_usd?: number;
    run_max_cost_usd?: number;
  };
  // ---- what came back ----
  cost?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd: number;
  };
  /** Final assistant text stitched from `llm.text_delta` events. */
  finalText: string;
  /** Stop reason reported on `llm.done`. */
  stopReason?: string;
}

/**
 * Fold a run's event stream into one StepSnapshot per `llm.start`.
 *
 * Pure: same input ⇒ same output. No clocks, no I/O. Called from the
 * HTTP route handler and from tests. Unknown payload fields are ignored
 * rather than rejected — the event envelope evolves independently of the
 * UI shape and rejecting unknown fields would break replay.
 */
export function eventsToSteps(events: readonly StepEvent[]): StepSnapshot[] {
  const steps: StepSnapshot[] = [];
  // nodeId → index of most-recently-opened still-open step on that node.
  // `llm.done` closes the entry so subsequent events on the same node
  // open a fresh step (retry / loop iteration).
  const openStepByNode = new Map<string, number>();

  for (const ev of events) {
    const data = (ev.payload ?? {}) as Record<string, unknown>;
    const nodeId = stringField(data, "nodeId");
    if (ev.type === "llm.start") {
      const startedAt = new Date(ev.ts).toISOString();
      const step: StepSnapshot = {
        stepIdx: steps.length,
        startSeq: ev.seq ?? steps.length,
        nodeId: nodeId || "__unknown",
        startedAt,
        prompt: stringField(data, "prompt"),
        systemPrompt: stringField(data, "system_prompt"),
        allowedTools: stringArrayField(data, "allowed_tools"),
        deniedTools: stringArrayField(data, "denied_tools"),
        messages: messageArrayField(data, "messages"),
        contextFiles: contextFilesField(data, "context_files"),
        skills: skillsField(data, "skills"),
        finalText: "",
      };
      assignOptional(step, data);
      steps.push(step);
      if (step.nodeId) openStepByNode.set(step.nodeId, steps.length - 1);
      continue;
    }

    if (!nodeId) continue;
    const idx = openStepByNode.get(nodeId);
    if (idx === undefined) continue;
    const step = steps[idx]!;

    if (ev.type === "llm.text_delta") {
      const delta = stringField(data, "delta");
      if (delta) step.finalText += delta;
      continue;
    }

    if (ev.type === "llm.done") {
      // Record the LAST llm.done in the window — tool-using turns emit
      // one llm.done per assistant message, all under a single llm.start.
      // Don't close the step here; it stays open until the next llm.start
      // for the same nodeId replaces it.
      step.endedAt = new Date(ev.ts).toISOString();
      const stopReason = stringField(data, "stop_reason");
      if (stopReason) step.stopReason = stopReason;
      const startedMs = Date.parse(step.startedAt);
      const endedMs = ev.ts;
      if (Number.isFinite(startedMs) && endedMs >= startedMs) {
        step.durationMs = endedMs - startedMs;
      }
    }
    // cost.recorded intentionally not handled here — see file header.
  }

  return steps;
}

/**
 * Cost / token aggregate row produced by `IEventStore.getStepAggregates()`,
 * shaped here to avoid a hard dependency on `@swarm/store` types in the
 * UI bundle. Wire-compatible with `StepAggregateRow`.
 */
export interface StepCostAggregate {
  startSeq: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costEventCount: number;
}

/**
 * Merge SQL-aggregated cost / token totals onto the step snapshots
 * produced by `eventsToSteps`. Steps with zero cost events get no
 * `cost` field — the UI uses that to decide whether to render the
 * cost-related badges and the context ring.
 */
export function attachStepAggregates(steps: StepSnapshot[], aggregates: readonly StepCostAggregate[]): StepSnapshot[] {
  const byStartSeq = new Map<number, StepCostAggregate>();
  for (const a of aggregates) byStartSeq.set(a.startSeq, a);
  return steps.map((s) => {
    const agg = byStartSeq.get(s.startSeq);
    if (!agg || agg.costEventCount === 0) return s;
    return {
      ...s,
      cost: {
        input_tokens: agg.inputTokens,
        output_tokens: agg.outputTokens,
        total_tokens: agg.totalTokens,
        cache_read_tokens: agg.cacheReadTokens,
        cache_write_tokens: agg.cacheWriteTokens,
        cost_usd: agg.costUsd,
      },
    };
  });
}

// ── field plucking helpers ──────────────────────────────────────────────
// All tolerate missing / wrong-typed fields — the UI renders partial data
// rather than blowing up on an older event envelope.

function assignOptional(step: StepSnapshot, data: Record<string, unknown>): void {
  const provider = stringField(data, "provider");
  if (provider) step.provider = provider;
  const model = stringField(data, "model");
  if (model) step.model = model;
  const threadId = stringField(data, "thread_id");
  if (threadId) step.threadId = threadId;
  const fidelity = stringField(data, "fidelity");
  if (fidelity) step.fidelity = fidelity;
  const iteration = iterationField(data, "iteration");
  if (iteration) step.iteration = iteration;
  const settings = settingsField(data, "settings");
  if (settings) step.settings = settings;
  const budget = budgetField(data, "budget");
  if (budget) step.budget = budget;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}

function stringArrayField(data: Record<string, unknown>, key: string): string[] {
  const v = data[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function messageArrayField(data: Record<string, unknown>, key: string): StepSnapshot["messages"] {
  const v = data[key];
  if (!Array.isArray(v)) return [];
  const out: StepSnapshot["messages"] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    const role = typeof mm["role"] === "string" ? (mm["role"] as string) : "unknown";
    const entry: { role: string; content?: unknown; timestamp?: number } = { role };
    if (mm["content"] !== undefined) entry.content = mm["content"];
    if (typeof mm["timestamp"] === "number") entry.timestamp = mm["timestamp"] as number;
    out.push(entry);
  }
  return out;
}

function contextFilesField(data: Record<string, unknown>, key: string): StepSnapshot["contextFiles"] {
  const v = data[key];
  if (!Array.isArray(v)) return [];
  const out: StepSnapshot["contextFiles"] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const rr = r as Record<string, unknown>;
    out.push({
      path: typeof rr["path"] === "string" ? (rr["path"] as string) : "",
      sha256: typeof rr["sha256"] === "string" ? (rr["sha256"] as string) : "",
      bytes: typeof rr["bytes"] === "number" ? (rr["bytes"] as number) : 0,
      truncated: rr["truncated"] === true,
      status: typeof rr["status"] === "string" ? (rr["status"] as string) : "unknown",
      ...(typeof rr["error"] === "string" ? { error: rr["error"] as string } : {}),
    });
  }
  return out;
}

function skillsField(data: Record<string, unknown>, key: string): StepSnapshot["skills"] {
  const v = data[key];
  if (!Array.isArray(v)) return [];
  const out: StepSnapshot["skills"] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const rr = r as Record<string, unknown>;
    const scopeStr = rr["scope"];
    const scope: "project" | "user" = scopeStr === "user" ? "user" : "project";
    out.push({
      name: typeof rr["name"] === "string" ? (rr["name"] as string) : "",
      location: typeof rr["location"] === "string" ? (rr["location"] as string) : "",
      sha256: typeof rr["sha256"] === "string" ? (rr["sha256"] as string) : "",
      bytes: typeof rr["bytes"] === "number" ? (rr["bytes"] as number) : 0,
      scope,
      source_dir: typeof rr["source_dir"] === "string" ? (rr["source_dir"] as string) : "",
    });
  }
  return out;
}

function iterationField(data: Record<string, unknown>, key: string): { n: number; max: number } | undefined {
  const v = data[key];
  if (!v || typeof v !== "object") return undefined;
  const vv = v as Record<string, unknown>;
  if (typeof vv["n"] !== "number" || typeof vv["max"] !== "number") return undefined;
  return { n: vv["n"] as number, max: vv["max"] as number };
}

function settingsField(data: Record<string, unknown>, key: string): StepSnapshot["settings"] | undefined {
  const v = data[key];
  if (!v || typeof v !== "object") return undefined;
  const vv = v as Record<string, unknown>;
  const out: NonNullable<StepSnapshot["settings"]> = {};
  if (typeof vv["temperature"] === "number") out.temperature = vv["temperature"] as number;
  if (typeof vv["max_tokens"] === "number") out.max_tokens = vv["max_tokens"] as number;
  if (typeof vv["top_p"] === "number") out.top_p = vv["top_p"] as number;
  if (typeof vv["reasoning_effort"] === "string") out.reasoning_effort = vv["reasoning_effort"] as string;
  const stop = vv["stop"];
  if (Array.isArray(stop)) out.stop = stop.filter((s): s is string => typeof s === "string");
  return Object.keys(out).length > 0 ? out : undefined;
}

function budgetField(data: Record<string, unknown>, key: string): StepSnapshot["budget"] | undefined {
  const v = data[key];
  if (!v || typeof v !== "object") return undefined;
  const vv = v as Record<string, unknown>;
  if (typeof vv["cumulative_cost_usd"] !== "number" || typeof vv["cumulative_tokens"] !== "number") return undefined;
  const out: NonNullable<StepSnapshot["budget"]> = {
    cumulative_cost_usd: vv["cumulative_cost_usd"] as number,
    cumulative_tokens: vv["cumulative_tokens"] as number,
  };
  if (typeof vv["max_cost_usd"] === "number") out.max_cost_usd = vv["max_cost_usd"] as number;
  if (typeof vv["run_max_cost_usd"] === "number") out.run_max_cost_usd = vv["run_max_cost_usd"] as number;
  return out;
}

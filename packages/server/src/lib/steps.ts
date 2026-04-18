// Pure reducer: Event[] → StepSnapshot[]. A "step" is one llm.start
// event (one backend.run() call). Waves 1–4 put every field the UI
// needs onto llm.start.data; this reducer folds in the companion
// events (text deltas, cost.recorded, llm.done) so the UI receives
// one fat object per step instead of replaying the stream itself.
//
// Kept in @swarm/server (not core) because it's a UI-shaping concern.
// Exported as a `Projection<StepSnapshot[]>` so a future DB-backed
// `MaterializedProjectionStore` can precompute + cache the result
// under the `"steps"` key without the route handler knowing.

import type { Event } from "@swarm/core";
import type { Projection } from "@swarm/events";

/** Stable key a MaterializedProjectionStore adapter would use to
 * identify this projection's precomputed rows. */
export const STEPS_PROJECTION_KEY = "steps";

export interface StepSnapshot {
  /** 0-based index within the run, ordered by timestamp. Stable across
   * refetches so the UI can scroll back to the same step. */
  stepIdx: number;
  /** Real DOT node id OR synthetic `__summary.*` / `__budget` id for
   * summariser / budget events. */
  nodeId: string;
  /** Iteration info when the step originated from a loop. */
  iteration?: { n: number; max: number };
  /** ISO timestamp of the originating llm.start. */
  startedAt: string;
  /** ISO of the matching llm.done when present (helps compute duration
   * without the UI having to subtract fields). */
  endedAt?: string;
  durationMs?: number;
  // ---- what the agent was asked -----------------------------------------
  provider?: string;
  model?: string;
  threadId?: string;
  fidelity?: string;
  /** Fully substituted user prompt. */
  prompt: string;
  /** System prompt assembled for this call (base + context_files block +
   * per-node system_prompt override). */
  systemPrompt: string;
  allowedTools: string[];
  deniedTools: string[];
  settings?: { temperature?: number; max_tokens?: number; top_p?: number; reasoning_effort?: string; stop?: string[] };
  /** Prior-turn transcript visible to the agent (Wave 1 capture). */
  messages: Array<{ role: string; content?: unknown; timestamp?: number }>;
  /** Per-file records with sha256 + bytes + truncated flag. */
  contextFiles: Array<{
    path: string;
    sha256: string;
    bytes: number;
    truncated: boolean;
    status: string;
    error?: string;
  }>;
  budget?: {
    cumulative_cost_usd: number;
    cumulative_tokens: number;
    max_cost_usd?: number;
    run_max_cost_usd?: number;
  };
  // ---- what came back ---------------------------------------------------
  cost?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    /** Prompt-cache read tokens (reused from prior calls) when reported. */
    cache_read_tokens?: number;
    /** First-time cache priming tokens when reported. */
    cache_write_tokens?: number;
    cost_usd: number;
  };
  /** Final assistant text stitched from llm.text_delta events. Empty when
   * the call streamed nothing (tool-only turn, summariser returning
   * structured data, etc.). */
  finalText: string;
  /** Stop reason reported on llm.done (or the matching message_end). */
  stopReason?: string;
}

/** Build a StepSnapshot[] from a run's events. Ordering: by llm.start
 * timestamp (ties broken by original stream order, which is what event
 * logs guarantee). Typed as `Projection<StepSnapshot[]>` so it plugs
 * straight into `projectRun` / `foldAll` from @swarm/events. */
export const stepsProjection: Projection<StepSnapshot[]> = (events) => eventsToSteps(events);

export function eventsToSteps(events: readonly Event[]): StepSnapshot[] {
  const steps: StepSnapshot[] = [];
  // (node_id, stepIdx) → position in the array. Multiple steps can share
  // a node_id (loop iterations, retries) so the map keys by
  // `${node_id}#${stepIdx}` but we only need the latest-open step per
  // node to attach subsequent events.
  const openStepByNode = new Map<string, number>();

  for (const ev of events) {
    if (ev.type === "llm.start" || ev.type === "summary.started") {
      const nodeId = ev.node_id ?? "__unknown";
      // summary.started events don't carry a resolved prompt / system
      // prompt — the summariser's input lives on `summary.completed.output_text`
      // post-hoc, and the "user prompt" it was framed with is the
      // summariser's internal system_prompt (not captured). The step
      // row still renders useful: nodeId, provider/model, purpose,
      // caller, iteration, streaming finalText as deltas arrive.
      const isSummary = ev.type === "summary.started";
      const step: StepSnapshot = {
        stepIdx: steps.length,
        nodeId,
        startedAt: ev.timestamp,
        prompt: isSummary ? "" : stringField(ev.data, "prompt"),
        systemPrompt: isSummary ? "" : stringField(ev.data, "system_prompt"),
        allowedTools: isSummary ? [] : stringArrayField(ev.data, "allowed_tools"),
        deniedTools: isSummary ? [] : stringArrayField(ev.data, "denied_tools"),
        messages: isSummary ? [] : messageArrayField(ev.data, "messages"),
        contextFiles: isSummary ? [] : contextFilesField(ev.data, "context_files"),
        finalText: "",
      };
      const provider = stringField(ev.data, "provider");
      if (provider) step.provider = provider;
      const model = stringField(ev.data, "model");
      if (model) step.model = model;
      const threadId = stringField(ev.data, "thread_id");
      if (threadId) step.threadId = threadId;
      const fidelity = stringField(ev.data, "fidelity");
      if (fidelity) step.fidelity = fidelity;
      const iteration = iterationField(ev.data, "iteration");
      if (iteration) step.iteration = iteration;
      const settings = settingsField(ev.data, "settings");
      if (settings) step.settings = settings;
      const budget = budgetField(ev.data, "budget");
      if (budget) step.budget = budget;

      steps.push(step);
      openStepByNode.set(nodeId, steps.length - 1);
      continue;
    }

    if (!ev.node_id) continue;
    const idx = openStepByNode.get(ev.node_id);
    if (idx === undefined) continue;
    const step = steps[idx]!;

    if (ev.type === "llm.text_delta" || ev.type === "summary.text_delta") {
      const delta = stringField(ev.data, "delta");
      if (delta) step.finalText += delta;
      continue;
    }

    if (ev.type === "llm.done") {
      step.endedAt = ev.timestamp;
      const stopReason = stringField(ev.data, "stop_reason");
      if (stopReason) step.stopReason = stopReason;
      const startedMs = Date.parse(step.startedAt);
      const endedMs = Date.parse(ev.timestamp);
      if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs) {
        step.durationMs = endedMs - startedMs;
      }
      // Close the step so later events on the same node don't attach.
      openStepByNode.delete(ev.node_id);
      continue;
    }

    if (ev.type === "summary.completed") {
      step.endedAt = ev.timestamp;
      const startedMs = Date.parse(step.startedAt);
      const endedMs = Date.parse(ev.timestamp);
      if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs) {
        step.durationMs = endedMs - startedMs;
      }
      // If streaming deltas didn't accumulate (some providers don't
      // stream — the provider fell back to a single chunk), take the
      // final output_text as the step's finalText.
      const outputText = stringField(ev.data, "output_text");
      if (outputText && step.finalText.length === 0) step.finalText = outputText;
      openStepByNode.delete(ev.node_id);
      continue;
    }

    if (ev.type === "cost.recorded") {
      const cost = costField(ev.data);
      if (cost) step.cost = cost;
    }

    // summary.completed under a synthetic node: already its own step.
    // Nothing to fold onto the caller step here — UIs can cross-link via
    // `caller_node_id` on the data payload if they want.
  }

  return steps;
}

// ── tiny field helpers (no runtime schema coupling; events.jsonl may
//    omit any field without breaking replay) ─────────────────────────

function stringField(data: unknown, key: string): string {
  if (!data || typeof data !== "object") return "";
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function stringArrayField(data: unknown, key: string): string[] {
  if (!data || typeof data !== "object") return [];
  const v = (data as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function messageArrayField(data: unknown, key: string): StepSnapshot["messages"] {
  if (!data || typeof data !== "object") return [];
  const v = (data as Record<string, unknown>)[key];
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

function contextFilesField(data: unknown, key: string): StepSnapshot["contextFiles"] {
  if (!data || typeof data !== "object") return [];
  const v = (data as Record<string, unknown>)[key];
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

function iterationField(data: unknown, key: string): { n: number; max: number } | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
  if (!v || typeof v !== "object") return undefined;
  const vv = v as Record<string, unknown>;
  if (typeof vv["n"] !== "number" || typeof vv["max"] !== "number") return undefined;
  return { n: vv["n"] as number, max: vv["max"] as number };
}

function settingsField(data: unknown, key: string): StepSnapshot["settings"] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
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

function budgetField(data: unknown, key: string): StepSnapshot["budget"] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const v = (data as Record<string, unknown>)[key];
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

function costField(data: unknown): StepSnapshot["cost"] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const vv = data as Record<string, unknown>;
  if (typeof vv["cost_usd"] !== "number") return undefined;
  const out: NonNullable<StepSnapshot["cost"]> = {
    input_tokens: typeof vv["input_tokens"] === "number" ? (vv["input_tokens"] as number) : 0,
    output_tokens: typeof vv["output_tokens"] === "number" ? (vv["output_tokens"] as number) : 0,
    cost_usd: vv["cost_usd"] as number,
  };
  if (typeof vv["total_tokens"] === "number") out.total_tokens = vv["total_tokens"] as number;
  if (typeof vv["cache_read_tokens"] === "number") out.cache_read_tokens = vv["cache_read_tokens"] as number;
  if (typeof vv["cache_write_tokens"] === "number") out.cache_write_tokens = vv["cache_write_tokens"] as number;
  return out;
}

// Thread + summary plumbing for the agent layer. Two concerns live here:
//
// 1. Message-store policy — when to hydrate prior messages into a new
//    Agent's `initialState.messages`, when to persist the final transcript
//    back to the store, when to do neither (fresh semantics). A node with
//    a resolved thread_id participates in the shared transcript: it
//    hydrates prior turns on dispatch and persists its own transcript on
//    completion so a daemon restart sees the same bytes. A node without a
//    thread_id runs against a fresh context — nothing in, nothing out.
//
// 2. sessionId policy for provider cache hits. pi-agent-core forwards
//    `sessionId` to cache-aware backends as a hint — it does NOT control
//    message restoration (that's the MessageStore). Picking the right
//    sessionId lets Anthropic/OpenAI prompt caching reuse the same cached
//    prefix across calls that share an effective prefix, and split the
//    namespace when the receiving node's view of the thread differs (raw
//    vs. summarised at a given level).
//
// Summary semantics: when a node sets `summary=low|medium|high`, the
// summariser compresses the prior thread before the node sees it. The
// summariser emits its own `summary.started / summary.text_delta /
// cost.recorded / summary.completed` events under a synthetic node id,
// so its cost lands on the run without contaminating the caller's
// `llm.start`. When no summariser is wired the seed falls back to a
// deterministic template — behaviour difference is visible in
// `events.jsonl` via the synthetic node.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EventType, SummariserBackend, SummaryLevel } from "@fragua/core";
import { summarySyntheticNodeId } from "@fragua/core";

/** Whether to hydrate prior messages from the store into the new Agent's
 * `initialState.messages`. True iff the node is on a thread. */
export function shouldHydrateFromStore(hasThread: boolean): boolean {
  return hasThread;
}

/** Whether to persist the agent's final transcript back to the store after
 * the run. Mirrors `shouldHydrateFromStore` — only threaded dispatches
 * contribute to the shared transcript. */
export function shouldPersistToStore(hasThread: boolean): boolean {
  return hasThread;
}

/** Reserved namespace for synthetic per-node threads. A node with no
 * explicit `thread:` still needs the persist/hydrate machinery so its
 * transcript survives a pause/resume of the same dispatch — without it the
 * node re-dispatches against an empty agent and silently drops its
 * mid-flight transcript on every resume (budget, provider_retry, timeout,
 * daemon restart). The leading NUL can't appear in a YAML `thread:` scalar,
 * so a synthetic id can never collide with a user-declared thread. */
export const SYNTHETIC_THREAD_PREFIX = "\u0000node:";

/** Deterministic synthetic thread id keyed by `(nodeId, iteration)`. A
 * resume of the same `(nodeId, iteration)` recomputes the same id and so
 * rehydrates the right transcript; a fresh loop pass (next iteration) gets a
 * distinct id and starts clean, preserving unthreaded "fresh each entry"
 * semantics. Readable on purpose — it surfaces in `llm.start.thread_id` and
 * on `messages` rows, where a digest would be opaque during a post-mortem.
 * The generator is injective over `(nodeId: string, iteration: ℕ)` and ids
 * are only ever compared for equality, never parsed, so a `#` inside a
 * nodeId is harmless. */
export function syntheticThreadId(nodeId: string, iteration: number): string {
  return `${SYNTHETIC_THREAD_PREFIX}${nodeId}#${iteration}`;
}

/** Pick a sessionId hint for provider-side prompt caching:
 *
 * | shape                               | sessionId                       | rationale |
 * |-------------------------------------|---------------------------------|-----------|
 * | thread, no summary                  | thread_id                       | same prefix → share cache |
 * | thread + summary=low/medium/high    | thread_id + ":summary-<level>"  | summarised prefix differs from raw — separate namespace but still groups retries at that level |
 * | no thread                           | undefined                       | one-shot call has nothing to key a cache bucket against |
 */
export function resolveSessionId(params: {
  threadId: string | undefined;
  summary: SummaryLevel | undefined;
}): string | undefined {
  if (!params.threadId) return undefined;
  if (params.summary === undefined) return params.threadId;
  return `${params.threadId}:summary-${params.summary}`;
}

export interface SummarySeed {
  /** Text to prepend to the user prompt. Empty string means "no seed". */
  seed: string;
  /** Soft warnings to surface as `agent.warning` events. Non-fatal — the
   * run continues with the best-effort behaviour. */
  warnings: string[];
}

/** Build the user-prompt seed when a node has opted into summarisation.
 *
 * Behaviour is deliberately minimal — when a seed exists, it is exactly
 * `<fragua-context summary="<level>">\n<text>\n</fragua-context>` and
 * nothing else. No goal / run-id / role-census framing; the receiving
 * agent has the workflow goal in its system prompt and the run id on
 * every event envelope.
 *
 * - `summary === undefined` → empty seed (raw thread is hydrated
 *   separately via `shouldHydrateFromStore`; nothing to inject).
 * - `priorMessages.length === 0` → empty seed (nothing to summarise).
 * - Summariser wired + succeeds → seed wraps the summariser output.
 * - Summariser unwired OR fails → empty seed + soft warning; the raw
 *   thread is still hydrated, so the receiving node degrades to
 *   uncompressed history rather than a fabricated template. */
export async function buildSummarySeed(params: {
  summary: SummaryLevel | undefined;
  graphGoal: string | undefined;
  runId: string;
  priorMessages: readonly AgentMessage[];
  summariser?: SummariserBackend;
  callerNodeId?: string;
  iteration?: { n: number; max: number };
  workflow_sha?: string;
  signal?: AbortSignal;
  emit?: (type: EventType, data: Record<string, unknown>, node_id: string) => Promise<void>;
}): Promise<SummarySeed> {
  const { summary, graphGoal, runId, priorMessages } = params;
  if (summary === undefined) return { seed: "", warnings: [] };
  if (priorMessages.length === 0) return { seed: "", warnings: [] };

  if (params.summariser && params.callerNodeId) {
    const syntheticNodeId = summarySyntheticNodeId(params.callerNodeId, params.iteration);
    const maxOutputTokens = summary === "high" ? 1500 : summary === "medium" ? 700 : 300;
    const transcriptForSummariser = renderTranscriptForSummariser(priorMessages);
    const built: SummariseInvocation = {
      purpose: "thread",
      input: transcriptForSummariser,
      ...(graphGoal !== undefined ? { goal: graphGoal } : {}),
      run_id: runId,
      workflow_sha: params.workflow_sha ?? "",
      synthetic_node_id: syntheticNodeId,
      caller_node_id: params.callerNodeId,
      ...(params.iteration !== undefined ? { iteration: params.iteration } : {}),
      summary,
      max_output_tokens: maxOutputTokens,
      ...(params.emit !== undefined ? { emit: params.emit } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    };
    const out = await params.summariser.summarise(built);
    if (out.ok && out.text.length > 0) {
      return { seed: `<fragua-context summary="${summary}">\n${out.text}\n</fragua-context>`, warnings: [] };
    }
    return {
      seed: "",
      warnings: [
        `summary="${summary}" summariser failed (${out.error ?? "unknown error"}); falling back to raw thread.`,
      ],
    };
  }

  return {
    seed: "",
    warnings: [`summary="${summary}" requested but no summariser backend is wired; falling back to raw thread.`],
  };
}

function renderTranscriptForSummariser(messages: readonly AgentMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : "unknown";
    const text = flattenTextContent((m as { content?: unknown }).content);
    parts.push(text.length > 0 ? `[${role}] ${text}` : `[${role}] (no text)`);
  }
  return parts.join("\n\n");
}

type SummariseInvocation = Parameters<SummariserBackend["summarise"]>[0];

function flattenTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.["type"] === "text" && typeof block["text"] === "string") out.push(block["text"] as string);
  }
  return out.join("\n");
}

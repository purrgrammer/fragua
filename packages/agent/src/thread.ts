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

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EventType, SummariserBackend, SummaryLevel } from "@swarm/core";
import { summarySyntheticNodeId } from "@swarm/core";

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
   * run continues with the best-effort seed. */
  warnings: string[];
}

const DEFAULT_FALLBACK_TEXT_CAP = 600;

/** Build the user-prompt seed when a node has opted into summarisation.
 *
 * - When `summary` is undefined → empty seed (raw thread is hydrated
 *   separately via `shouldHydrateFromStore`; nothing to inject).
 * - When `summary` is set AND there's prior content AND a summariser is
 *   wired → make a real summariser call; the call emits its own events
 *   under a synthetic node id (cost.recorded + summary.*) so run cost
 *   attribution rolls up automatically.
 * - When `summary` is set but no summariser is wired OR the call fails →
 *   fall back to a deterministic template (role census + most-recent
 *   assistant text) and surface a soft warning. */
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

  const goalLine = graphGoal ? `Goal: ${graphGoal}` : "Goal: (unspecified)";
  const runLine = `Run: ${runId}`;
  const priorCount = priorMessages.length;

  if (params.summariser && priorCount > 0 && params.callerNodeId) {
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
      const seed = [
        `<swarm-context summary="${summary}">`,
        goalLine,
        runLine,
        `Prior turns: ${priorCount}. Summariser: ${out.provider}/${out.model}.`,
        `<summariser-narrative>`,
        out.text,
        `</summariser-narrative>`,
        `</swarm-context>`,
      ].join("\n");
      return { seed, warnings: [] };
    }
    return {
      seed: buildFallbackSeed(summary, goalLine, runLine, priorMessages, DEFAULT_FALLBACK_TEXT_CAP),
      warnings: [
        `summary="${summary}" summariser failed (${out.error ?? "unknown error"}). Falling back to deterministic template.`,
      ],
    };
  }

  return {
    seed: buildFallbackSeed(summary, goalLine, runLine, priorMessages, DEFAULT_FALLBACK_TEXT_CAP),
    warnings: params.summariser
      ? []
      : [`summary="${summary}" requested but no summariser backend is wired. Falling back to deterministic template.`],
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

function buildFallbackSeed(
  tag: SummaryLevel,
  goalLine: string,
  runLine: string,
  messages: readonly AgentMessage[],
  textCap: number,
): string {
  const body =
    messages.length === 0
      ? "No prior turns."
      : `Prior turns: ${messages.length}. Role census: ${countRoles(messages)
          .map(([r, n]) => `${r}=${n}`)
          .join(", ")}.\n${renderTail(messages, textCap)}`;
  return `<swarm-context summary="${tag}">\n${goalLine}\n${runLine}\n${body}\n</swarm-context>`;
}

function renderTail(messages: readonly AgentMessage[], textCap: number): string {
  const tail = extractLatestAssistantText(messages, textCap);
  if (tail === undefined) return "Most recent assistant text: (none visible)";
  return `Most recent assistant text (clamped ${textCap} chars):\n<prior-tail>\n${tail}\n</prior-tail>`;
}

function countRoles(messages: readonly AgentMessage[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of messages) {
    const role = typeof (m as { role?: unknown }).role === "string" ? (m as { role: string }).role : "unknown";
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts.entries()];
}

function extractLatestAssistantText(messages: readonly AgentMessage[], cap: number): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    const text = flattenTextContent(m.content);
    if (text.length === 0) continue;
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  }
  return undefined;
}

function flattenTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.["type"] === "text" && typeof block["text"] === "string") out.push(block["text"] as string);
  }
  return out.join("\n");
}

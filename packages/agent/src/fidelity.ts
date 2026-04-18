// Fidelity-driven plumbing for the agent layer. Two concerns live here:
//
// 1. Message-store policy per fidelity mode — which mode reads prior turns
//    into `initialState.messages`, which writes them back after the run,
//    which does neither (fresh semantics). The SPEC says only `full` keeps
//    the session; every other mode is fresh + seeded.
//
// 2. sessionId policy for provider cache hits. pi-agent-core forwards
//    `sessionId` to cache-aware backends as a hint — it does NOT control
//    message restoration (that's the MessageStore). Picking the right
//    sessionId lets Anthropic/OpenAI prompt caching reuse the same cached
//    prefix across calls that share an effective prefix, and split the
//    namespace across calls that don't. See the table below.
//
// Seed semantics (what gets prepended to the user prompt for non-full modes):
//   - `truncate`     : goal + run_id marker only (spec §3.3)
//   - `compact`      : deterministic tier-1/2 digest of prior messages
//   - `summary:low`  : deterministic narrative template (no LLM)
//   - `summary:*`    : Wave 2 MVP falls back to summary:low with a
//                      diagnostic; Wave 2b wires an LLM summariser.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { FidelityMode } from "@swarm/core";

/** Whether this fidelity mode should hydrate prior messages from the store
 * into the new Agent's `initialState.messages`. Only `full` does. */
export function shouldHydrateFromStore(fidelity: FidelityMode, isFresh: boolean): boolean {
  if (isFresh) return false;
  return fidelity === "full";
}

/** Whether this fidelity mode should persist the agent's final transcript
 * back to the store after the run. Only `full` does — other modes are
 * explicitly fresh and wouldn't benefit from caching their own transcript
 * under the shared thread_id (that would corrupt subsequent `full` calls
 * on the same thread). */
export function shouldPersistToStore(fidelity: FidelityMode, isFresh: boolean): boolean {
  if (isFresh) return false;
  return fidelity === "full";
}

/** Pick a sessionId hint per fidelity so provider-side prompt caching
 * bucket-splits cleanly:
 *
 * | fidelity        | sessionId                      | rationale |
 * |-----------------|--------------------------------|-----------|
 * | full            | thread_id                      | same prefix → share cache |
 * | truncate        | thread_id + ":truncate"        | stable prefix across truncate calls (goal seed); separate namespace from full |
 * | compact         | thread_id + ":compact"         | prefix varies with digest but is deterministic; still groups retries |
 * | summary:low     | thread_id + ":summary-low"     | same — groups retries; separate namespace |
 * | summary:medium  | thread_id + ":summary-medium"  | same |
 * | summary:high    | thread_id + ":summary-high"    | same |
 * | context=fresh   | undefined                      | opt-out of caching + session hints entirely |
 *
 * Without thread_id, returns `undefined` regardless — a one-shot call has
 * nothing to key a cache bucket against. */
export function resolveSessionId(params: {
  fidelity: FidelityMode;
  threadId: string | undefined;
  isFresh: boolean;
}): string | undefined {
  if (params.isFresh) return undefined;
  if (!params.threadId) return undefined;
  if (params.fidelity === "full") return params.threadId;
  return `${params.threadId}:${params.fidelity}`;
}

export interface FidelitySeed {
  /** Text to prepend to the user prompt. Empty string means "no seed". */
  seed: string;
  /** Soft warnings to surface as `agent.warning` events. Non-fatal — the
   * run continues with the best-effort seed. */
  warnings: string[];
}

const DEFAULT_COMPACT_LAST_TEXT_CAP = 1_500;
const DEFAULT_SUMMARY_LAST_TEXT_CAP = 600;

/** Build the user-prompt seed for a given fidelity mode. Pure — no I/O,
 * no LLM calls (even `summary:medium/high` downgrade here; a real
 * summariser lives in Wave 2b and will replace the fallback branch). */
export function buildFidelitySeed(params: {
  fidelity: FidelityMode;
  graphGoal: string | undefined;
  runId: string;
  /** Transcript of prior turns available under the target thread. Empty
   * when no prior session exists for this thread. `compact` and `summary:*`
   * reduce this to fit the mode's token budget. */
  priorMessages: readonly AgentMessage[];
}): FidelitySeed {
  const { fidelity, graphGoal, runId, priorMessages } = params;
  if (fidelity === "full") return { seed: "", warnings: [] };

  const goalLine = graphGoal ? `Goal: ${graphGoal}` : "Goal: (unspecified)";
  const runLine = `Run: ${runId}`;

  if (fidelity === "truncate") {
    return {
      seed: `<swarm-context fidelity="truncate">\n${goalLine}\n${runLine}\nNo prior conversation is carried into this call.\n</swarm-context>`,
      warnings: [],
    };
  }

  const priorCount = priorMessages.length;

  if (fidelity === "compact") {
    const digest = digestPriorMessages(priorMessages, DEFAULT_COMPACT_LAST_TEXT_CAP);
    const body =
      priorCount === 0 ? "No prior conversation is carried into this call." : `Prior turns: ${priorCount}.\n${digest}`;
    return {
      seed: `<swarm-context fidelity="compact">\n${goalLine}\n${runLine}\n${body}\n</swarm-context>`,
      warnings: [],
    };
  }

  if (fidelity === "summary:low") {
    return {
      seed: buildSummarySeed("summary:low", goalLine, runLine, priorMessages, DEFAULT_SUMMARY_LAST_TEXT_CAP),
      warnings: [],
    };
  }

  // summary:medium / summary:high — Wave 2b lands the real summariser.
  // Today the seed is identical to summary:low so the behaviour is at
  // least well-defined, but we emit a warning so a workflow author sees
  // that they're not actually getting the richer tier they asked for.
  return {
    seed: buildSummarySeed(fidelity, goalLine, runLine, priorMessages, DEFAULT_SUMMARY_LAST_TEXT_CAP),
    warnings: [
      `fidelity="${fidelity}" requested but no summariser backend is wired (Wave 2b). Falling back to summary:low behaviour for this call.`,
    ],
  };
}

/** Extract the most-recent assistant text + a short role census. Used by
 * `compact`. Intentionally deterministic — no LLM. */
function digestPriorMessages(messages: readonly AgentMessage[], textCap: number): string {
  if (messages.length === 0) return "Prior turns: 0.";
  const roleCounts = countRoles(messages);
  const rolesLine = roleCounts.map(([role, n]) => `${role}=${n}`).join(", ");
  const tail = extractLatestAssistantText(messages, textCap);
  if (tail === undefined) return `Roles seen: ${rolesLine}.`;
  return `Roles seen: ${rolesLine}.\nMost recent assistant text (clamped ${textCap} chars):\n<prior-tail>\n${tail}\n</prior-tail>`;
}

function buildSummarySeed(
  tag: FidelityMode,
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
  return `<swarm-context fidelity="${tag}">\n${goalLine}\n${runLine}\n${body}\n</swarm-context>`;
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

// Two harness-level uses of the System One client, both off unless the
// config turns them on and both a no-op when the run carries no judge:
//
//   - skill suggestion: before the turn, one call ranks the node's visible
//     skills against its prompt and asks whether the request needs a skill
//     at all; a winner becomes one line at the end of the system prompt.
//     The catalogue itself is untouched so the prompt-cache prefix holds.
//   - tool guard: before a side-effecting tool runs, one call asks whether
//     the call is destructive, off the step's task, or ships project
//     contents out. `flag` annotates the tool result and warns; `block`
//     refuses the call with a tool error the model can read.
//
// Both keep policy in code: the questions are fixed, the thresholds are
// constants here, the raw probabilities land on the events.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { JUDGE_DEFAULT_MODEL } from "@fragua/core";
import type { JudgeAnswer, JudgeClient, JudgeRequest } from "@fragua/core/handler";
import { judgeCostPayload } from "@fragua/core/handler";
import type { Skill } from "@fragua/workspace";
import { isMcpToolName } from "@fragua/workspace";

export type ToolGuardMode = "off" | "flag" | "block";

export interface JudgeAssistConfig {
  skillSuggestion: boolean;
  toolGuard: ToolGuardMode;
}

export const DEFAULT_JUDGE_ASSIST: JudgeAssistConfig = { skillSuggestion: false, toolGuard: "off" };

/** Below this many visible skills a suggestion has nothing to disambiguate. */
const SUGGESTION_MIN_SKILLS = 2;
/** The prompt is the state; past this many characters the head is enough. */
const PROMPT_STATE_CHARS = 6_000;
/** p(yes) at which "the request needs a skill" and a flag question fire. */
const NOUL_THRESHOLD = 0.5;
/** The winning skill's own probability has to clear this to be suggested. */
const SKILL_MIN_PROBABILITY = 0.4;
const NO_SKILL = "none";

export interface SkillSuggestion {
  /** Set when a skill cleared both gates. */
  skill?: string;
  probability: number;
  needsSkill: number;
  /** The `cost.recorded` payload — emitted by the caller once `llm.start` is out. */
  cost: Record<string, unknown>;
}

export function suggestionLine(skill: string): string {
  return `Relevant to this step: ${skill}. Ignore this if it does not fit what the step actually asks for.`;
}

/** One call over the visible skills. A provider failure is the caller's to
 * report as a warning — the turn never depends on the suggestion. */
export async function suggestSkill(
  judge: JudgeClient,
  prompt: string,
  skills: readonly Skill[],
  signal: AbortSignal,
): Promise<SkillSuggestion | undefined> {
  const visible = skills.filter((s) => !s.disabled_reason);
  if (visible.length < SUGGESTION_MIN_SKILLS) return undefined;
  const criteria: Record<string, string> = {};
  for (const s of visible) criteria[s.name] = s.description;
  criteria[NO_SKILL] = "No listed skill fits what the request asks for.";
  const req: JudgeRequest = {
    model: JUDGE_DEFAULT_MODEL,
    state: {
      request: prompt.slice(0, PROMPT_STATE_CHARS),
      skills: visible.map((s) => ({ name: s.name, description: s.description })),
    },
    questions: {
      skill: {
        type: "choice",
        instructions:
          "Which of the `skills` gives the procedure `request` asks the agent to follow? Pick `none` when the request is answered by ordinary engineering work or conversation and no skill's description names it.",
        criteria,
      },
      needs_skill: {
        type: "noul",
        instructions:
          "Does `request` ask for work that one of the `skills` describes — acting on the project by a specific documented method — rather than plain conversation, explanation, or a task any competent engineer does unaided?",
        criteria: {
          true: "A listed skill's description covers the kind of work requested.",
          false: "No skill's method applies; the request is general work or conversation.",
        },
      },
    },
  };
  const res = await judge.ask(req, signal);
  const choice = res.answers["skill"];
  const needs = res.answers["needs_skill"];
  if (choice?.type !== "choice" || needs?.type !== "noul") return undefined;
  const probability = choice.probabilities[choice.choice] ?? 0;
  const out: SkillSuggestion = {
    probability,
    needsSkill: needs.noul,
    cost: judgeCostPayload(judge.provider, res),
  };
  if (choice.choice !== NO_SKILL && needs.noul >= NOUL_THRESHOLD && probability >= SKILL_MIN_PROBABILITY) {
    out.skill = choice.choice;
  }
  return out;
}

// ─── tool guard ────────────────────────────────────────────────────────

/** The core tools whose effects reach the working tree or a shell. Reads,
 * the exit tools and the judge itself are never guarded. */
const GUARDED_CORE_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

export function isGuardedTool(name: string): boolean {
  return GUARDED_CORE_TOOLS.has(name) || isMcpToolName(name);
}

export interface GuardFlag {
  question: string;
  probability: number;
}

export interface GuardVerdict {
  flags: GuardFlag[];
  cost: Record<string, unknown>;
}

const GUARD_QUESTIONS: JudgeRequest["questions"] = {
  destructive: {
    type: "noul",
    instructions:
      "Would running `call.tool` with `call.arguments` delete or overwrite data that is hard to recover — removing files or directories outside a scratch area, rewriting shared git history, dropping or truncating a database, or force-overwriting a file the step did not create?",
    criteria: {
      true: "The call removes or overwrites something that cannot be recovered by re-running the step.",
      false: "The call creates, reads, or edits in a way the step can redo or undo.",
    },
  },
  off_task: {
    type: "noul",
    instructions:
      "Does `call` act on files, services or systems that `step` does not ask the agent to touch — for example editing an unrelated part of the repository, changing global tool configuration, or reaching a service the step never mentions?",
    criteria: {
      true: "The call's target is outside anything the step's instructions ask for.",
      false: "The call's target is something the step asks for or plainly needs to do its work.",
    },
  },
  exfiltrates: {
    type: "noul",
    instructions:
      "Does `call` send project contents, credentials, tokens or environment variables to a destination outside the machine — an upload, a request carrying secrets, a message to an external service?",
    criteria: {
      true: "The call transmits repository contents or secrets to an outside destination.",
      false: "The call keeps data local, or sends only what the step explicitly asks it to publish.",
    },
  },
};

export async function guardToolCall(
  judge: JudgeClient,
  stepPrompt: string,
  tool: string,
  args: unknown,
  signal: AbortSignal,
): Promise<GuardVerdict> {
  const req: JudgeRequest = {
    model: JUDGE_DEFAULT_MODEL,
    state: {
      step: stepPrompt.slice(0, PROMPT_STATE_CHARS),
      call: { tool, arguments: JSON.stringify(args ?? null).slice(0, PROMPT_STATE_CHARS) },
    },
    questions: GUARD_QUESTIONS,
  };
  const res = await judge.ask(req, signal);
  const flags: GuardFlag[] = [];
  for (const id of Object.keys(GUARD_QUESTIONS)) {
    const a: JudgeAnswer | undefined = res.answers[id];
    if (a?.type === "noul" && a.noul >= NOUL_THRESHOLD) flags.push({ question: id, probability: a.noul });
  }
  return { flags, cost: judgeCostPayload(judge.provider, res) };
}

export function describeFlags(flags: readonly GuardFlag[]): string {
  return flags.map((f) => `${f.question} ${f.probability.toFixed(2)}`).join(", ");
}

export interface GuardHooks {
  judge: JudgeClient;
  mode: Exclude<ToolGuardMode, "off">;
  stepPrompt: string;
  emit: (type: "agent.warning" | "cost.recorded", data: Record<string, unknown>) => void;
}

/** Wrap an agent tool so every call is judged first. A provider failure
 * degrades to a warning and the call proceeds — the guard never becomes an
 * outage. */
export function guardedAgentTool(tool: AgentTool, hooks: GuardHooks): AgentTool {
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      let verdict: GuardVerdict;
      try {
        verdict = await guardToolCall(
          hooks.judge,
          hooks.stepPrompt,
          tool.label ?? tool.name,
          params,
          signal ?? new AbortController().signal,
        );
      } catch (err) {
        hooks.emit("agent.warning", {
          kind: "tool_guard",
          tool: tool.label ?? tool.name,
          message: `tool guard skipped: ${err instanceof Error ? err.message : String(err)}`,
        });
        return inner(toolCallId, params, signal, onUpdate);
      }
      hooks.emit("cost.recorded", verdict.cost);
      if (verdict.flags.length === 0) return inner(toolCallId, params, signal, onUpdate);
      const shown = describeFlags(verdict.flags);
      hooks.emit("agent.warning", {
        kind: "tool_guard",
        tool: tool.label ?? tool.name,
        mode: hooks.mode,
        flags: verdict.flags,
        message: `tool guard ${hooks.mode === "block" ? "blocked" : "flagged"} ${tool.label ?? tool.name}: ${shown}`,
      });
      if (hooks.mode === "block") {
        // Thrown, not returned: pi-agent-core turns a throw into an error
        // tool result the model reads as such, which a returned envelope
        // with a details flag is not.
        throw new Error(
          `blocked by the tool guard (${shown}). The call was not run. If it is what the step needs, say so in your reply and stop; an operator decides.`,
        );
      }
      const result = await inner(toolCallId, params, signal, onUpdate);
      return {
        ...result,
        content: [...result.content, { type: "text", text: `tool guard flagged this call: ${shown}` }],
      };
    },
  };
}

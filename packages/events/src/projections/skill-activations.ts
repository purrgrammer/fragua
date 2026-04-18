// Which skills were *actually loaded* in a run. Folds `tool.execution_start`
// events where the tool is `local:load_skill` (tier-2 activation) OR
// `local:subagent` with a `preload_skills` arg (parent-pre-activated in a
// child session). Catalog-only advertisements via `llm.start.skills[]` do
// NOT count — the distinction matters for the /skills/:name "used in recent
// runs" panel: we want skills the model actually pulled, not ones that were
// merely on the shelf.

import type { Projection } from "../projection.ts";

export interface SkillActivationsByRun {
  /** Keyed by skill name. `count` sums activations across steps, so a
   * skill loaded twice in one run contributes 2. */
  [skill_name: string]: { count: number };
}

export const skillActivationsProjection: Projection<SkillActivationsByRun> = (events) => {
  const out: SkillActivationsByRun = {};
  for (const ev of events) {
    if (ev.type !== "tool.execution_start") continue;
    const data = ev.data as { tool_name?: unknown; args?: unknown } | undefined;
    if (!data || typeof data.tool_name !== "string") continue;
    if (data.tool_name === "local:load_skill") {
      const args = data.args as { name?: unknown } | undefined;
      if (args && typeof args.name === "string") {
        bump(out, args.name);
      }
    } else if (data.tool_name === "local:subagent") {
      const args = data.args as { preload_skills?: unknown } | undefined;
      if (args && Array.isArray(args.preload_skills)) {
        for (const n of args.preload_skills) {
          if (typeof n === "string") bump(out, n);
        }
      }
    }
  }
  return out;
};

function bump(out: SkillActivationsByRun, name: string): void {
  const entry = out[name];
  if (entry) entry.count += 1;
  else out[name] = { count: 1 };
}

/** Per-skill aggregate across all runs: which runs loaded each skill and
 * how many times. Shape matches `/skills/:name` "Used in recent runs". */
export interface SkillUsageAcrossRuns {
  [skill_name: string]: { runs: string[]; count: number };
}

/** Fold a sequence of (runId, projection-output) pairs into a per-skill
 * usage map. Separate from the projection itself so the caller controls
 * ordering and filtering. */
export function foldSkillUsage(input: Iterable<{ runId: string; byRun: SkillActivationsByRun }>): SkillUsageAcrossRuns {
  const out: SkillUsageAcrossRuns = {};
  for (const { runId, byRun } of input) {
    for (const [name, { count }] of Object.entries(byRun)) {
      const entry = out[name] ?? { runs: [], count: 0 };
      entry.count += count;
      if (!entry.runs.includes(runId)) entry.runs.push(runId);
      out[name] = entry;
    }
  }
  return out;
}

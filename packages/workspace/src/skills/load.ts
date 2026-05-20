// loadSkill — resolve a skill by catalogue name, read its SKILL.md,
// substitute $ARGUMENTS, and return both the structured payload (for
// the event store / UI card) and the rendered markdown (for the LLM
// tool-result message).
//
// Lives alongside `parse.ts` + `catalog.ts`. Keeps frontmatter parsing
// central — only `name` + `description` are honoured by the catalogue;
// other frontmatter keys are dropped along with the rest of the YAML
// block (they would confuse the model with metadata it can't act on).
//
// Substitution mirrors the workflow-prompt convention: every $ARGUMENTS
// boundary is replaced with the input string (empty when absent). When
// the body has no placeholder but args were passed, they're appended
// as a trailing <invocation> block so they're never silently dropped.

import type { ExecutionEnvironment } from "@swarm/core";
import type { Skill } from "@swarm/types";
import { parseSkillMd } from "./parse.ts";

export interface LoadSkillSuccess {
  ok: true;
  name: string;
  description: string;
  /** Resolved SKILL.md path — project or global. */
  path: string;
  /** Body post-$ARGUMENTS substitution. The structured payload that
   *  rides on `tool.execution_end.data.result.details.data`. */
  content: string;
  /** Model-facing markdown: `# Skill: <name>\n_<description>_\n\n<content>`. */
  rendered: string;
}

export interface LoadSkillFailure {
  ok: false;
  /** Tool-error message, ready to surface to the model. */
  message: string;
  /** Catalogue names available at call time, so the LLM can recover. */
  available: string[];
}

export type LoadSkillResult = LoadSkillSuccess | LoadSkillFailure;

export async function loadSkill(
  env: Pick<ExecutionEnvironment, "readFile">,
  name: string,
  args: string | undefined,
  catalog: readonly Skill[],
): Promise<LoadSkillResult> {
  const visible = catalog.filter((s) => !s.disabled_reason);
  const skill = visible.find((s) => s.name === name);
  if (!skill) {
    const available = visible.map((s) => s.name).sort();
    const list = available.length === 0 ? "(catalogue is empty)" : available.join(", ");
    return {
      ok: false,
      message: `unknown skill "${name}". available: ${list}`,
      available,
    };
  }

  const raw = await env.readFile(skill.location);
  const parsed = parseSkillMd(raw);
  const fmName = typeof parsed.frontmatter["name"] === "string" ? (parsed.frontmatter["name"] as string) : skill.name;
  const fmDescription =
    typeof parsed.frontmatter["description"] === "string"
      ? (parsed.frontmatter["description"] as string)
      : skill.description;

  const argsString = args ?? "";
  const { body, hadPlaceholder } = substituteArguments(parsed.body, argsString);
  const finalBody =
    !hadPlaceholder && argsString.length > 0 ? `${body}\n\n<invocation>${argsString}</invocation>` : body;

  const rendered = `# Skill: ${fmName}\n_${fmDescription}_\n\n${finalBody}`;
  return {
    ok: true,
    name: fmName,
    description: fmDescription,
    path: skill.location,
    content: finalBody,
    rendered,
  };
}

/** Replace every `$ARGUMENTS` boundary occurrence with `value`. Boundary
 *  matching mirrors `replaceBoundary` in
 *  `packages/core/src/engine/substitution.ts` — `$ARGUMENTS` followed by
 *  `[A-Za-z0-9_]` is left intact (so a hypothetical `$ARGUMENTSx` token
 *  survives). We don't reuse `substitute()` here because it would also
 *  expand `${context.x}` / `$<nodeId>.output` etc., which are workflow-
 *  level constructs that have no meaning inside a skill body. */
function substituteArguments(body: string, value: string): { body: string; hadPlaceholder: boolean } {
  const re = /\$ARGUMENTS(?![A-Za-z0-9_])/g;
  let hadPlaceholder = false;
  const out = body.replace(re, () => {
    hadPlaceholder = true;
    return value;
  });
  return { body: out, hadPlaceholder };
}

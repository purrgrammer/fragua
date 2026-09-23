// `skill` tool — load a skill from the catalogue.
//
// Always available on every llm call. The catalogue is the same
// set rendered into `<available_skills>` in the system prompt; this
// tool turns "model decides to use skill X" into an explicit,
// observable tool call instead of a `read` against `<location>`.
//
// Wiring lives in `packages/agent/src/backend.ts` — even when a node
// pins `allowed_tools` or lists `skill` under `denied_tools`, the
// backend force-includes this tool in the AgentTool array. Built-in
// is built-in.
//
// Structured payload on `data` rides the existing tool-result channel
// (`tool.execution_end.data.result.details.data`) — same place every
// other built-in tool lands its UI-friendly metadata.

import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ExecutionEnvironment } from "@fragua/core";
import { Type } from "@sinclair/typebox";
import { loadSkill } from "./skills/load.ts";
import type { Skill } from "./skills/types.ts";
import type { Tool } from "./types.ts";

export interface SkillToolArgs {
  name: string;
  arguments?: string;
}

export interface SkillToolData {
  name: string;
  description: string;
  path: string;
  content: string;
}

export const skillTool: Tool<SkillToolArgs, SkillToolData> = {
  name: "skill",
  description:
    "Load a skill by name from the available_skills catalogue rendered in the system prompt. Substitutes `$ARGUMENTS` in the skill body with the `arguments` string. When the body has no `$ARGUMENTS` placeholder and `arguments` are provided, they are appended as a trailing `<invocation>...</invocation>` block instead of being silently dropped. Returns the rendered SKILL.md body for you to follow as instructions.",
  parameters: Type.Object(
    {
      name: Type.String({
        description: "Catalogue name. Matches one of the <name> values shown in <available_skills>.",
      }),
      arguments: Type.Optional(
        Type.String({
          description:
            "Substituted into every $ARGUMENTS occurrence in the skill body. When the body has no placeholder, appended as <invocation>...</invocation>. Omit when the skill takes no input.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  idempotent: true,
  truncation: { max_chars: 200_000, mode: "head_tail" },
  async execute(args, env, opts) {
    const catalog = opts?.fraguaContext?.skillCatalog ?? [];
    const out = await loadSkill(
      { readFile: (path) => readSkillFile(env, catalog, path) },
      args.name,
      args.arguments,
      catalog,
    );
    if (!out.ok) {
      return {
        text: out.message,
        is_error: true,
        data: { name: args.name, description: "", path: "", content: out.message },
      };
    }
    return {
      text: out.rendered,
      data: { name: out.name, description: out.description, path: out.path, content: out.content },
    };
  },
};

/**
 * Read a catalogue skill's `SKILL.md`.
 *
 * A project skill lives IN the working tree, so a run gets its own
 * checkout's copy — a worktree that edits a skill sees the edit, and the
 * env's path gate is honoured. That read is by the path relative to the
 * project the skill was discovered under, so it lands inside the worktree
 * rather than on the discovery path (which points at the main checkout and
 * the gate would refuse).
 *
 * Everything else — user-scope skills under `~/.agents`, and a project skill
 * the run's tree does not carry (a worktree branched before it was added) —
 * is catalogue content on the daemon's filesystem, read directly. Discovery
 * put it there; it is not the run's to gate.
 */
async function readSkillFile(
  env: Pick<ExecutionEnvironment, "readFile">,
  catalog: readonly Skill[],
  location: string,
): Promise<string> {
  const skill = catalog.find((s) => s.location === location);
  const anchor = skill?.project_cwd;
  if (anchor !== undefined) {
    const rel = relative(anchor, location);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
      try {
        return await env.readFile(rel);
      } catch {
        // Not in this run's tree (or refused) — fall through to the
        // discovery path, so a stale worktree still loads the skill.
      }
    }
  }
  return readFile(location, "utf8");
}

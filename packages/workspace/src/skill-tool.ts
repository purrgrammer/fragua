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

import { Type } from "@sinclair/typebox";
import { loadSkill } from "./skills/load.ts";
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
    const out = await loadSkill(env, args.name, args.arguments, catalog);
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

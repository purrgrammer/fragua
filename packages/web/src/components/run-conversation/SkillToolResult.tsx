// Custom rendering for the `skill` core tool. Slots into <ToolContent>'s
// output area when toolName === "skill" inside RichToolResult. Result
// shape is produced by `packages/workspace/src/skill-tool.ts`.
//
// The structured payload (`name`, `description`, `path`, `content`) lands
// on `result.details.data` \u2014 same channel every other built-in tool uses.
// Without a dedicated card the operator would see a generic ToolOutput
// dump of the rendered SKILL.md body; the skill load is a distinct beat
// in the run timeline, so it earns its own viz.

import type { ToolResultMessage } from "@swarm/types";
import { BookOpenIcon } from "lucide-react";
import type { JSX } from "react";

export interface SkillToolParams {
  name?: string;
  arguments?: string;
}

export interface SkillToolData {
  name?: string;
  description?: string;
  path?: string;
  content?: string;
  available?: string[];
}

const SECTION_LABEL = "font-medium uppercase text-[length:var(--sw-text-xs)] text-[var(--sw-muted)] tracking-[0.06em]";
const PANEL =
  "rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] bg-[var(--sw-surface)] " +
  "px-[var(--sw-space-3)] py-[var(--sw-space-2)] text-[length:var(--sw-text-xs)]";

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return "";
}

interface SkillToolResultProps {
  params: SkillToolParams | undefined;
  result: ToolResultMessage | undefined;
  isStreaming?: boolean;
}

export function SkillToolResult({ params, result, isStreaming }: SkillToolResultProps): JSX.Element {
  // Args can come from either side: `params.name` is what the model
  // requested; `data.name` is what the loader resolved (frontmatter
  // override). Prefer the resolved value, fall back to the requested.
  const data = ((result?.details as { data?: SkillToolData } | undefined)?.data ?? {}) as SkillToolData;
  const isError = result?.isError === true;
  const requestedName = params?.name;
  const resolvedName = data.name ?? requestedName ?? "(unnamed)";
  const description = data.description ?? "";
  const path = data.path ?? "";
  const argsString = params?.arguments ?? "";
  const body = data.content ?? firstText(result?.content);

  return (
    <div className="space-y-[var(--sw-space-3)]">
      <div className="flex items-start gap-[var(--sw-space-2)]" data-testid="skill-card-header">
        <BookOpenIcon
          className="mt-0.5 size-4 shrink-0"
          style={{ color: isError ? "var(--sw-accent-error)" : "var(--sw-muted)" }}
        />
        <div className="min-w-0 flex-1 space-y-[var(--sw-space-1)]">
          <div className="flex items-baseline gap-[var(--sw-space-2)]">
            <span className="font-mono text-[length:var(--sw-text-sm)]" data-testid="skill-card-name">
              {resolvedName}
            </span>
            {path ? (
              <span className="truncate font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">{path}</span>
            ) : null}
          </div>
          {description ? (
            <p className="text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]" data-testid="skill-card-description">
              {description}
            </p>
          ) : null}
        </div>
      </div>

      {argsString.length > 0 ? (
        <div className="space-y-[var(--sw-space-1)]">
          <div className={SECTION_LABEL}>Arguments</div>
          <div
            className={`${PANEL} font-mono`}
            data-testid="skill-card-arguments"
            // Single-line clamp so very long argument strings don't blow
            // out the card's vertical rhythm.
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {argsString}
          </div>
        </div>
      ) : null}

      {isError ? (
        <div
          className={`${PANEL} font-mono`}
          data-testid="skill-card-error"
          style={{ color: "var(--sw-accent-error)" }}
        >
          {firstText(result?.content)}
        </div>
      ) : body.length > 0 ? (
        <details className="space-y-[var(--sw-space-1)]" data-testid="skill-card-body">
          <summary className={`${SECTION_LABEL} cursor-pointer`}>Body ({body.length.toLocaleString()} chars)</summary>
          <pre className={`${PANEL} mt-[var(--sw-space-1)] max-h-[24rem] overflow-auto whitespace-pre-wrap font-mono`}>
            {body}
          </pre>
        </details>
      ) : isStreaming ? (
        <div className={SECTION_LABEL}>Loading\u2026</div>
      ) : null}
    </div>
  );
}

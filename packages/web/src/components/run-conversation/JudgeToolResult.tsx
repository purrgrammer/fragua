// Custom rendering for the `judge` core tool. Slots into <ToolContent>'s
// output area when toolName === "judge" inside RichToolResult and replaces the
// raw parameter dump: the state the agent assembled, each question with its
// answer as probability bars, and the model / token / cost line. Result shape
// is produced by `packages/workspace/src/judge-tool.ts`.

import type { ToolResultMessage } from "@fragua/types";
import type { JSX } from "react";
import { isRecord, type JudgeQuestionType, QuestionBlock } from "./judge-answers.tsx";
import { firstText, PANEL, SECTION_LABEL, toolData } from "./tool-result-helpers.ts";

export interface JudgeToolParams {
  state?: unknown;
  questions?: Record<string, { type?: string; instructions?: unknown; criteria?: unknown }>;
}

export interface JudgeToolData {
  model?: string;
  answers?: Record<string, unknown>;
  input_tokens?: number;
  cost_usd?: number;
}

interface JudgeToolResultProps {
  params: JudgeToolParams | undefined;
  result: ToolResultMessage | undefined;
}

const QUESTION_TYPES = new Set<string>(["choice", "score", "noul"]);

export function JudgeToolResult({ params, result }: JudgeToolResultProps): JSX.Element {
  const data = toolData<JudgeToolData>(result);
  const answers = data.answers ?? {};
  const questions = Object.entries(params?.questions ?? {});
  const pending = result === undefined;
  const errorText = result?.isError ? firstText(result.content) : "";

  return (
    <div className="flex flex-col gap-3" data-testid="judge-tool-card">
      <section className="space-y-2">
        <h4 className={SECTION_LABEL}>State</h4>
        <StateView value={params?.state} />
      </section>
      <section className="space-y-2">
        <h4 className={SECTION_LABEL}>{questions.length === 1 ? "1 question" : `${questions.length} questions`}</h4>
        <div className="flex flex-col rounded-sw-card border border-sw-border bg-sw-surface">
          {questions.length === 0 ? (
            <span className="px-3 py-2 text-sw-xs text-sw-muted">no questions</span>
          ) : (
            questions.map(([id, q]) => (
              <QuestionBlock
                key={id}
                id={id}
                type={questionType(q.type)}
                instructions={q.instructions}
                criteria={q.criteria}
                answer={answers[id]}
                pending={pending}
              />
            ))
          )}
        </div>
      </section>
      {errorText !== "" ? (
        <p className="text-sw-xs text-sw-accent-error" data-testid="judge-tool-error">
          {errorText}
        </p>
      ) : null}
      {!pending && errorText === "" ? <MetaLine data={data} /> : null}
    </div>
  );
}

function questionType(t: string | undefined): JudgeQuestionType {
  return t !== undefined && QUESTION_TYPES.has(t) ? (t as JudgeQuestionType) : "choice";
}

function MetaLine({ data }: { data: JudgeToolData }): JSX.Element {
  const parts = [
    data.model,
    typeof data.input_tokens === "number" ? `${data.input_tokens.toLocaleString()} input tokens` : undefined,
    typeof data.cost_usd === "number" ? `$${data.cost_usd.toFixed(4)}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return <p className="text-sw-xs text-sw-muted">{parts.join(" · ")}</p>;
}

// ─── state ─────────────────────────────────────────────────────────────
//
// The state is whatever the agent assembled: a string, or a JSON tree of text
// fields. Scalars render inline next to their key; long strings get their own
// preformatted block; nested objects and arrays indent one level per depth so
// `findings[2].cited_code` is findable by eye.

const LONG_TEXT = 120;

function StateView({ value: raw }: { value: unknown }): JSX.Element {
  const value = typeof raw === "string" ? (parseJsonTree(raw) ?? raw) : raw;
  if (value === undefined) return <span className="text-sw-xs text-sw-muted">no state</span>;
  if (typeof value === "string") return <TextBlock text={value} />;
  if (!isRecord(value) && !Array.isArray(value)) return <TextBlock text={String(value)} />;
  return (
    <div className={`${PANEL} max-h-96 overflow-auto`} data-testid="judge-tool-state">
      <StateTree value={value} depth={0} />
    </div>
  );
}

function StateTree({ value, depth }: { value: unknown; depth: number }): JSX.Element {
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [`[${i}]`, v] as [string, unknown])
    : isRecord(value)
      ? Object.entries(value)
      : [];
  return (
    <ul className={`flex flex-col gap-1 ${depth > 0 ? "border-l border-sw-border pl-3" : ""}`}>
      {entries.map(([k, v]) => {
        const nested = isRecord(v) || Array.isArray(v);
        const long = typeof v === "string" && (v.length > LONG_TEXT || v.includes("\n"));
        return (
          <li key={k} className={nested || long ? "flex flex-col gap-1" : "flex gap-2"}>
            <span className="shrink-0 font-medium text-sw-text">{k}</span>
            {nested ? (
              <StateTree value={v} depth={depth + 1} />
            ) : long ? (
              <TextBlock text={v as string} />
            ) : (
              <span className="min-w-0 break-words text-sw-muted">{typeof v === "string" ? v : JSON.stringify(v)}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Agents often serialise the state themselves and pass one JSON string; a
// string that parses to an object or array is shown as the tree it encodes.
function parseJsonTree(text: string): Record<string, unknown> | unknown[] | undefined {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isRecord(v) || Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function TextBlock({ text }: { text: string }): JSX.Element {
  return (
    <pre
      className={`${PANEL} max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono`}
      data-testid="judge-tool-text"
    >
      {text}
    </pre>
  );
}

// Shared rendering for a System One answer — used by the judge *step* card
// (JudgeNodeRow) and the judge *tool* card (JudgeToolResult) so a question
// looks the same wherever it was asked: instruction text, then every option
// as a labelled probability bar with the chosen one emphasised, confidence as
// a secondary label. A torn answer is named as such rather than coloured.

import type { JSX } from "react";

export type JudgeQuestionType = "choice" | "score" | "noul";

interface Option {
  label: string;
  p: number;
  chosen: boolean;
}

interface ParsedAnswer {
  options: Option[];
  confidence?: number;
  torn: boolean;
}

interface QuestionBlockProps {
  id: string;
  type: JudgeQuestionType;
  instructions: unknown;
  criteria?: unknown;
  answer: unknown;
  pending?: boolean;
}

export function QuestionBlock({ id, type, instructions, criteria, answer, pending }: QuestionBlockProps): JSX.Element {
  const parsed = parseAnswer(type, answer);
  // Score legends are sentences; choice ids and yes/no are words. Give the
  // label column the room its content needs so a level's meaning is readable
  // without hovering.
  const labelWidth = type === "score" ? "w-[28rem] max-w-[45%]" : "w-40";
  return (
    <div
      className="flex flex-col gap-2 border-b border-sw-border px-3 py-3 last:border-b-0"
      data-testid="judge-question"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sw-sm font-medium">{id}</span>
        <span className="text-sw-xs text-sw-muted">{type}</span>
        {parsed?.torn ? <span className="text-sw-xs text-sw-muted">undecided</span> : null}
        {parsed?.confidence !== undefined ? (
          <span className="ml-auto text-sw-xs text-sw-muted">confidence {parsed.confidence.toFixed(2)}</span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-sw-xs text-sw-muted">{instructionText(instructions)}</p>
      {parsed === undefined ? criteria !== undefined ? <CriteriaList type={type} criteria={criteria} /> : null : null}
      {parsed === undefined ? (
        <span className="text-sw-xs text-sw-muted">{pending ? "awaiting answer" : "no answer"}</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {parsed.options.map((o) => (
            <li key={o.label} className="flex items-center gap-2">
              <span
                data-option-label
                title={o.label}
                className={`${labelWidth} shrink-0 truncate text-sw-sm ${o.chosen ? "font-semibold" : "text-sw-muted"}`}
              >
                {o.label}
              </span>
              <span className="relative h-2 flex-1 rounded-sw-default bg-sw-border">
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 rounded-sw-default ${o.chosen ? "bg-sw-text" : "bg-sw-accent-idle"}`}
                  style={{ width: `${Math.round(Math.max(0, Math.min(1, o.p)) * 100)}%` }}
                />
              </span>
              <span className={`w-10 shrink-0 text-right text-sw-xs ${o.chosen ? "" : "text-sw-muted"}`}>
                {o.p.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Before an answer exists the criteria are the only thing that says what the
// options mean; once the answer lands the bars carry the labels themselves.
function CriteriaList({ type, criteria }: { type: JudgeQuestionType; criteria: unknown }): JSX.Element | null {
  const rows: Array<[string, string]> = [];
  if (type === "score" && Array.isArray(criteria)) {
    criteria.forEach((c, i) => {
      rows.push([String(i), textOf(c)]);
    });
  } else if (isRecord(criteria)) {
    for (const [k, v] of Object.entries(criteria)) rows.push([k, textOf(v)]);
  }
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-sw-xs text-sw-muted">
      {rows.map(([k, v]) => (
        <li key={k} className="flex gap-2">
          <span className="w-40 shrink-0 truncate">{k}</span>
          <span className="min-w-0 flex-1 truncate">{v}</span>
        </li>
      ))}
    </ul>
  );
}

export function parseAnswer(type: JudgeQuestionType, answer: unknown): ParsedAnswer | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  if (type === "noul") {
    if (typeof a["noul"] !== "number") return undefined;
    const p = num(a["noul"]);
    return {
      options: [
        { label: "yes", p, chosen: p >= 0.5 },
        { label: "no", p: 1 - p, chosen: p < 0.5 },
      ],
      torn: p > 0.4 && p < 0.6,
    };
  }
  const probs = isRecord(a["probabilities"]) ? a["probabilities"] : undefined;
  if (probs === undefined) return undefined;
  const confidence = typeof a["confidence"] === "number" ? a["confidence"] : undefined;
  const torn = confidence !== undefined && confidence < 0.5;
  if (type === "choice") {
    const chosen = typeof a["choice"] === "string" ? a["choice"] : undefined;
    const options = Object.entries(probs)
      .map(([label, p]) => ({ label, p: num(p), chosen: label === chosen }))
      .sort((x, y) => y.p - x.p);
    return { options, torn, ...(confidence !== undefined ? { confidence } : {}) };
  }
  const legend = isRecord(a["legend"]) ? a["legend"] : {};
  const entries = Object.entries(probs).map(([k, p]) => ({ k, p: num(p) }));
  const top = entries.reduce<string | undefined>(
    (best, e) => (best === undefined || e.p > num(probs[best]) ? e.k : best),
    undefined,
  );
  const options = entries
    .sort((x, y) => Number(x.k) - Number(y.k))
    .map(({ k, p }) => ({
      label: typeof legend[k] === "string" ? `${k} · ${legend[k]}` : `level ${k}`,
      p,
      chosen: k === top,
    }));
  return { options, torn, ...(confidence !== undefined ? { confidence } : {}) };
}

export function instructionText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (isRecord(v) && typeof v["question"] === "string") return v["question"];
  return JSON.stringify(v);
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

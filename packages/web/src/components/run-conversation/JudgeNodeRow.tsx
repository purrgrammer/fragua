// Rendering for a `judge_node` message — what a judge step asked and what the
// System One model answered. One block per question: the instruction text,
// then every option as a labelled probability bar with the chosen one
// emphasized. The decision (route / outcome) closes the card.

import type { JudgeNodeMessage } from "@fragua/types";
import type { JSX } from "react";
import { formatDuration } from "../../lib/time.ts";

interface JudgeNodeRowProps {
  message: JudgeNodeMessage;
  nodeId?: string;
  testid: string;
}

export function JudgeNodeRow({ message, nodeId, testid }: JudgeNodeRowProps): JSX.Element {
  const meta = [nodeId, message.model, formatDuration(message.durationMs)].filter(Boolean).join(" · ");
  return (
    <div data-testid={testid} className="flex flex-col rounded-sw-card border border-sw-border bg-sw-surface">
      <div className="flex items-center gap-2 border-b border-sw-border px-3 py-2 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">
        <span className="flex-1">judge</span>
        <span className="truncate">{meta}</span>
      </div>
      {Object.entries(message.questions).map(([id, q]) => (
        <QuestionBlock key={id} id={id} type={q.type} instructions={q.instructions} answer={message.answers[id]} />
      ))}
      {message.decision !== undefined ? <DecisionLine decision={message.decision} /> : null}
    </div>
  );
}

// ─── one question ──────────────────────────────────────────────────────

interface Option {
  label: string;
  p: number;
  chosen: boolean;
}

function QuestionBlock({
  id,
  type,
  instructions,
  answer,
}: {
  id: string;
  type: "choice" | "score" | "noul";
  instructions: unknown;
  answer: unknown;
}): JSX.Element {
  const parsed = parseAnswer(type, answer);
  return (
    <div className="flex flex-col gap-2 border-b border-sw-border px-3 py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="text-sw-sm font-medium">{id}</span>
        <span className="text-sw-xs text-sw-muted">{type}</span>
        {parsed?.confidence !== undefined ? (
          <span className="ml-auto text-sw-xs text-sw-muted">confidence {parsed.confidence.toFixed(2)}</span>
        ) : null}
      </div>
      <p className="line-clamp-3 text-sw-xs text-sw-muted">{instructionText(instructions)}</p>
      {parsed === undefined ? (
        <span className="text-sw-xs text-sw-muted">no answer</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {parsed.options.map((o) => (
            <li key={o.label} className="flex items-center gap-2">
              <span
                data-option-label
                className={`w-40 shrink-0 truncate text-sw-sm ${o.chosen ? "font-semibold" : "text-sw-muted"}`}
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

function parseAnswer(
  type: "choice" | "score" | "noul",
  answer: unknown,
): { options: Option[]; confidence?: number } | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const a = answer as Record<string, unknown>;
  if (type === "noul") {
    const p = num(a["noul"]);
    return {
      options: [
        { label: "yes", p, chosen: p >= 0.5 },
        { label: "no", p: 1 - p, chosen: p < 0.5 },
      ],
    };
  }
  const probs = isRecord(a["probabilities"]) ? a["probabilities"] : {};
  if (type === "choice") {
    const chosen = typeof a["choice"] === "string" ? a["choice"] : undefined;
    const options = Object.entries(probs)
      .map(([label, p]) => ({ label, p: num(p), chosen: label === chosen }))
      .sort((x, y) => y.p - x.p);
    return { options, ...(typeof a["confidence"] === "number" ? { confidence: a["confidence"] } : {}) };
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
  return { options, ...(typeof a["confidence"] === "number" ? { confidence: a["confidence"] } : {}) };
}

// ─── decision ──────────────────────────────────────────────────────────

function DecisionLine({ decision }: { decision: NonNullable<JudgeNodeMessage["decision"]> }): JSX.Element {
  const tone =
    decision.kind === "outcome"
      ? decision.status === "success"
        ? "bg-sw-accent-success"
        : "bg-sw-accent-error"
      : decision.belowThreshold
        ? "bg-sw-accent-warn"
        : "bg-sw-accent-success";
  const text =
    decision.kind === "outcome"
      ? decision.status === "success"
        ? "gate passed — outcome success"
        : "gate failed — outcome fail"
      : decision.belowThreshold
        ? `routed to ${decision.route} — the chosen option was below the confidence floor`
        : `routed to ${decision.route}`;
  return (
    <div className="flex items-center gap-2 border-t border-sw-border px-3 py-2 text-sw-sm">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone}`} />
      <span>{text}</span>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function instructionText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (isRecord(v) && typeof v["question"] === "string") return v["question"];
  return JSON.stringify(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Rendering for a `judge_node` message — the questions a judge step asked and
// the typed answers a System One model returned. No transcript, no tool
// calls: one row per question, the decision (route / outcome) last.

import type { JudgeNodeMessage } from "@fragua/types";
import type { JSX } from "react";
import { formatDuration } from "../../lib/time.ts";

interface JudgeNodeRowProps {
  message: JudgeNodeMessage;
  nodeId?: string;
  testid: string;
}

export function JudgeNodeRow({ message, nodeId, testid }: JudgeNodeRowProps): JSX.Element {
  const header = [nodeId, message.model, formatDuration(message.durationMs)].filter(Boolean).join(" · ");
  return (
    <div data-testid={testid} className="flex flex-col rounded-sw-card border border-sw-border bg-sw-surface">
      <div className="flex items-center gap-2 border-b border-sw-border px-3 py-2 text-sw-xs text-sw-muted uppercase tracking-[0.06em]">
        <span className="flex-1 truncate">judge</span>
        <span className="truncate">{header}</span>
      </div>
      <ul className="flex flex-col">
        {Object.entries(message.questions).map(([id, q]) => (
          <li key={id} className="flex items-baseline gap-3 border-b border-sw-border px-3 py-2 last:border-b-0">
            <span className="w-32 shrink-0 truncate text-sw-sm">{id}</span>
            <span className="w-14 shrink-0 text-sw-xs text-sw-muted">{q.type}</span>
            <span className="flex-1 truncate text-sw-sm">{formatAnswer(message.answers[id])}</span>
          </li>
        ))}
      </ul>
      {message.decision !== undefined ? (
        <div className="flex items-center gap-2 border-t border-sw-border px-3 py-2 text-sw-sm">
          <DecisionDot decision={message.decision} />
          <span>{formatDecision(message.decision)}</span>
        </div>
      ) : null}
    </div>
  );
}

function DecisionDot({ decision }: { decision: NonNullable<JudgeNodeMessage["decision"]> }): JSX.Element {
  const tone =
    decision.kind === "outcome"
      ? decision.status === "success"
        ? "bg-sw-accent-success"
        : "bg-sw-accent-error"
      : decision.belowThreshold
        ? "bg-sw-accent-warn"
        : "bg-sw-accent-success";
  return <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone}`} />;
}

function formatDecision(decision: NonNullable<JudgeNodeMessage["decision"]>): string {
  if (decision.kind === "outcome") return `outcome ${decision.status}`;
  return decision.belowThreshold ? `route ${decision.route} (below confidence floor)` : `route ${decision.route}`;
}

function formatAnswer(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) return "—";
  const a = answer as Record<string, unknown>;
  if (a["type"] === "noul") return `p(yes) ${fmt(a["noul"])}`;
  if (a["type"] === "choice") {
    const probs = a["probabilities"];
    const dist =
      typeof probs === "object" && probs !== null
        ? Object.entries(probs as Record<string, unknown>)
            .map(([k, v]) => `${k} ${fmt(v)}`)
            .join(" · ")
        : "";
    return `${String(a["choice"])} — conf ${fmt(a["confidence"])}${dist ? ` — ${dist}` : ""}`;
  }
  if (a["type"] === "score") {
    const probs = a["probabilities"];
    const dist =
      typeof probs === "object" && probs !== null
        ? Object.values(probs as Record<string, unknown>)
            .map((v) => fmt(v))
            .join(" · ")
        : "";
    return `score ${fmt(a["score"])} — conf ${fmt(a["confidence"])}${dist ? ` — [${dist}]` : ""}`;
  }
  return JSON.stringify(answer);
}

function fmt(v: unknown): string {
  return typeof v === "number" ? v.toFixed(2) : "?";
}

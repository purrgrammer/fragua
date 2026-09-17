// Rendering for a `judge_node` message — what a judge step asked and what the
// System One model answered. One block per question: the instruction text,
// then every option as a labelled probability bar with the chosen one
// emphasized. The decision (route / outcome) closes the card.

import type { JudgeNodeMessage } from "@fragua/types";
import type { JSX } from "react";
import { formatDuration } from "../../lib/time.ts";
import { QuestionBlock } from "./judge-answers.tsx";

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
      {message.forEach !== undefined ? (
        <ForEachBlocks message={message} forEach={message.forEach} />
      ) : (
        Object.entries(message.questions).map(([id, q]) => (
          <QuestionBlock key={id} id={id} type={q.type} instructions={q.instructions} answer={message.answers[id]} />
        ))
      )}
      {message.decision !== undefined ? <DecisionLine decision={message.decision} /> : null}
    </div>
  );
}

// ─── for-each: one group per item ──────────────────────────────────────
//
// A list judge asks every question once per item; the answers come back keyed
// `<q>__<i>`. Group them by item so the card reads "item 3 — kept: holds 0.91,
// severity high" rather than 2N interleaved blocks.

function ForEachBlocks({
  message,
  forEach,
}: {
  message: JudgeNodeMessage;
  forEach: NonNullable<JudgeNodeMessage["forEach"]>;
}): JSX.Element {
  const keptSet = forEach.kept === undefined ? undefined : new Set(forEach.kept);
  const indices = Array.from({ length: forEach.count }, (_, i) => i);
  return (
    <>
      {indices.map((i) => {
        const verdict = keptSet === undefined ? undefined : keptSet.has(i) ? "kept" : "dropped";
        return (
          <div
            key={i}
            data-testid="judge-item"
            data-verdict={verdict}
            className="border-b border-sw-border last:border-b-0"
          >
            <div className="flex items-center gap-2 px-3 pt-3 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">
              <span>item {i}</span>
              {verdict !== undefined ? (
                <>
                  <span
                    aria-hidden
                    className={`size-1.5 rounded-full ${verdict === "kept" ? "bg-sw-accent-success" : "bg-sw-accent-idle"}`}
                  />
                  <span>{verdict}</span>
                </>
              ) : null}
            </div>
            {Object.entries(message.questions).map(([id, q]) => (
              <QuestionBlock
                key={id}
                id={id}
                type={q.type}
                instructions={q.instructions}
                answer={message.answers[`${id}__${i}`]}
              />
            ))}
          </div>
        );
      })}
    </>
  );
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

// Rendering for a `judge_node` message — what a judge step asked and what the
// System One model answered. One block per question: the instruction text,
// then every option as a labelled probability bar with the chosen one
// emphasized. The decision (route / outcome) closes the card.

import type { JudgeNodeMessage } from "@fragua/types";
import type { JSX } from "react";
import { formatDuration } from "../../lib/time.ts";
import { type NoulThreshold, QuestionBlock } from "./judge-answers.tsx";

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
          <QuestionBlock
            key={id}
            id={id}
            type={q.type}
            instructions={q.instructions}
            answer={message.answers[id]}
            threshold={outcomeBound(message.decision, id)}
          />
        ))
      )}
      {message.composites !== undefined ? (
        <CompositeLine values={message.composites} decision={message.decision} />
      ) : null}
      {message.decision !== undefined ? <DecisionLine decision={message.decision} /> : null}
    </div>
  );
}

// ─── composites ────────────────────────────────────────────────────────

function CompositeLine({
  values,
  decision,
  rules,
}: {
  values: Record<string, number>;
  decision?: JudgeNodeMessage["decision"];
  rules?: NonNullable<JudgeNodeMessage["forEach"]>["rules"];
}): JSX.Element {
  const boundOf = (name: string): string => {
    const b = outcomeBound(decision, name) ?? ruleBound(rules, name);
    if (b === undefined) return "";
    return ` ${b.min !== undefined ? `≥ ${b.min}` : ""}${b.max !== undefined ? ` ≤ ${b.max}` : ""}`.replace(
      /\s+/g,
      " ",
    );
  };
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-0.5 px-3 py-2 text-sw-xs text-sw-muted" data-testid="judge-composites">
      {Object.entries(values).map(([name, v]) => (
        <li key={name}>
          <span className="text-sw-text">{name}</span> composite {v.toFixed(2)}
          {boundOf(name)}
        </li>
      ))}
    </ul>
  );
}

function ruleBound(rules: NonNullable<JudgeNodeMessage["forEach"]>["rules"], id: string): NoulThreshold | undefined {
  const rule = rules?.find((r) => r.question === id);
  if (rule === undefined) return undefined;
  return { ...(rule.min !== undefined ? { min: rule.min } : {}), ...(rule.max !== undefined ? { max: rule.max } : {}) };
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
  const boundFor = (id: string): NoulThreshold | undefined => {
    const rule = forEach.rules?.find((r) => r.question === id);
    if (rule === undefined) return undefined;
    return {
      ...(rule.min !== undefined ? { min: rule.min } : {}),
      ...(rule.max !== undefined ? { max: rule.max } : {}),
    };
  };
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
              {forEach.labels?.[i] !== undefined ? (
                <span
                  className="min-w-0 truncate normal-case tracking-normal text-sw-text"
                  data-testid="judge-item-label"
                >
                  {forEach.labels[i]}
                </span>
              ) : null}
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
                threshold={boundFor(id)}
              />
            ))}
            {forEach.composites?.[i] !== undefined ? (
              <CompositeLine values={forEach.composites[i]} rules={forEach.rules} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// ─── decision ──────────────────────────────────────────────────────────

type RouteDecision = Extract<NonNullable<JudgeNodeMessage["decision"]>, { kind: "route" }>;

function routeText(d: RouteDecision): string {
  const measures: string[] = [];
  if (d.confidence !== undefined) {
    measures.push(
      `confidence ${d.confidence.toFixed(2)}${d.minConfidence !== undefined ? ` (floor ${d.minConfidence})` : ""}`,
    );
  }
  if (d.probability !== undefined) {
    measures.push(
      `probability ${d.probability.toFixed(2)}${d.minProbability !== undefined ? ` (floor ${d.minProbability})` : ""}`,
    );
  }
  const tail = measures.length > 0 ? ` — ${measures.join(", ")}` : "";
  return d.belowThreshold ? `routed to ${d.route}${tail} — below the floor` : `routed to ${d.route}${tail}`;
}

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
      : routeText(decision);
  return (
    <div className="flex flex-col gap-1 border-t border-sw-border px-3 py-2 text-sw-sm">
      <div className="flex items-center gap-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${tone}`} />
        <span>{text}</span>
      </div>
      {decision.kind === "outcome" ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-0.5 pl-4 text-sw-xs text-sw-muted" data-testid="judge-rules">
          {decision.rules.map((r) => (
            <li key={r.question} className={r.holds ? "" : "text-sw-accent-error"}>
              {r.question} {r.value.toFixed(2)} {r.min !== undefined ? `≥ ${r.min}` : ""}{" "}
              {r.max !== undefined ? `≤ ${r.max}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function outcomeBound(decision: JudgeNodeMessage["decision"], id: string): NoulThreshold | undefined {
  if (decision === undefined || decision.kind !== "outcome") return undefined;
  const r = decision.rules.find((x) => x.question === id);
  if (r === undefined) return undefined;
  return { ...(r.min !== undefined ? { min: r.min } : {}), ...(r.max !== undefined ? { max: r.max } : {}) };
}

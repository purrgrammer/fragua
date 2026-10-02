// Custom rendering for the opt-in `agent` tool (orchestrator-workers). Slots
// into <ToolContent>'s output area when toolName === "agent" inside
// RichToolResult. A worker is a second agent loop that ran inside the calling
// turn; its transcript persists under a synthetic node id
// (`__agent.<caller>#<n>/<toolCallId>`) and never enters the caller's context,
// so the card is the only place an operator sees it: status + cost line, the
// task the caller delegated, the typed outputs it handed back, and the worker
// transcript as a collapsed mini-conversation (the same shape a `parallel`
// branch uses). Rows render through `renderRow`, supplied by RunConversation,
// so this file does not import the row renderer back (no import cycle).

import type { ToolResultMessage } from "@fragua/types";
import { type JSX, type ReactNode, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RunMessageRow } from "@/lib/api";
import { cn } from "@/lib/utils";
import { firstText, PANEL, SECTION_LABEL, toolData } from "./tool-result-helpers.ts";

export interface AgentToolParams {
  task?: string;
  model?: string;
  provider?: string;
  effort?: string;
  allowed_tools?: string[];
  outputs?: unknown;
  max_cost_usd?: number;
}

export type AgentWorkerStatus = "completed" | "aborted" | "max_cost" | "max_turns" | "timeout" | "error";

export interface AgentToolData {
  text?: string;
  outputs?: unknown;
  cost_usd?: number;
  turns?: number;
  tool_calls?: number;
  worker_id?: string;
  status?: AgentWorkerStatus;
}

interface AgentToolResultProps {
  params: AgentToolParams | undefined;
  result: ToolResultMessage | undefined;
  /** The worker's persisted transcript rows (`__agent.*` node id), in ordinal
   * order. Empty while the worker has not produced a row yet. */
  workerRows: readonly RunMessageRow[];
  renderRow: (row: RunMessageRow) => ReactNode;
}

const STATUS_LABEL: Record<AgentWorkerStatus, string> = {
  completed: "completed",
  aborted: "aborted",
  max_cost: "cost cap reached",
  max_turns: "turn cap reached",
  timeout: "timed out",
  error: "error",
};

const STATUS_DOT: Record<AgentWorkerStatus | "running", string> = {
  running: "sw-pulse bg-sw-accent-thinking",
  completed: "bg-sw-accent-success",
  aborted: "bg-sw-accent-idle",
  max_cost: "bg-sw-accent-warn",
  max_turns: "bg-sw-accent-warn",
  timeout: "bg-sw-accent-warn",
  error: "bg-sw-accent-error",
};

export function AgentToolResult({ params, result, workerRows, renderRow }: AgentToolResultProps): JSX.Element {
  const data = toolData<AgentToolData>(result);
  const pending = result === undefined;
  const status: AgentWorkerStatus | "running" = pending
    ? "running"
    : (data.status ?? (result.isError ? "error" : "completed"));
  const text = data.text ?? firstText(result?.content);
  const messageCount = workerRows.filter((r) => r.content.role !== "toolResult").length;

  return (
    <div className="flex flex-col gap-3" data-testid="agent-tool-card">
      <div className="flex flex-wrap items-center gap-2 text-sw-xs">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
        <span className="font-medium text-sw-text" data-testid="agent-tool-status">
          {status === "running" ? "worker running" : `worker ${STATUS_LABEL[status]}`}
        </span>
        <MetaLine params={params} data={data} pending={pending} />
      </div>

      <section className="space-y-2">
        <h4 className={SECTION_LABEL}>Task</h4>
        <TaskText text={params?.task ?? ""} />
      </section>

      {data.outputs !== undefined ? (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>Outputs</h4>
          <pre
            className={`${PANEL} max-h-72 overflow-auto whitespace-pre-wrap break-words`}
            data-testid="agent-tool-outputs"
          >
            {JSON.stringify(data.outputs, null, 2)}
          </pre>
        </section>
      ) : null}

      {!pending && text !== "" ? (
        <section className="space-y-2">
          <h4 className={SECTION_LABEL}>{status === "completed" ? "Report" : "Reason"}</h4>
          <pre
            className={cn(
              `${PANEL} max-h-72 overflow-auto whitespace-pre-wrap break-words`,
              status === "error" ? "text-sw-accent-error" : "",
            )}
            data-testid="agent-tool-text"
          >
            {text}
          </pre>
        </section>
      ) : null}

      <WorkerTranscript rows={workerRows} count={messageCount} pending={pending} renderRow={renderRow} />
    </div>
  );
}

function MetaLine({
  params,
  data,
  pending,
}: {
  params: AgentToolParams | undefined;
  data: AgentToolData;
  pending: boolean;
}): JSX.Element {
  const parts = [
    params?.model,
    params?.effort !== undefined ? `effort ${params.effort}` : undefined,
    !pending && typeof data.turns === "number" ? `${data.turns} ${data.turns === 1 ? "turn" : "turns"}` : undefined,
    !pending && typeof data.tool_calls === "number" ? `${data.tool_calls} tool calls` : undefined,
    !pending && typeof data.cost_usd === "number" ? `$${data.cost_usd.toFixed(4)}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return <span className="text-sw-muted">{parts.join(" · ")}</span>;
}

const TASK_FOLD = 320;

function TaskText({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (text === "") return <span className="text-sw-xs text-sw-muted">no task</span>;
  const long = text.length > TASK_FOLD;
  const shown = long && !open ? `${text.slice(0, TASK_FOLD).trimEnd()}…` : text;
  return (
    <div className="space-y-1">
      <pre className={`${PANEL} whitespace-pre-wrap break-words`} data-testid="agent-tool-task">
        {shown}
      </pre>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-sw-xs text-sw-muted underline-offset-2 hover:text-sw-text hover:underline"
        >
          {open ? "show less" : `show all ${text.length.toLocaleString()} chars`}
        </button>
      ) : null}
    </div>
  );
}

/** The worker's own transcript as a collapsed mini-conversation. Collapsed by
 * default like a `parallel` branch: the header carries the count, the operator
 * expands to read what the worker actually did. */
function WorkerTranscript({
  rows,
  count,
  pending,
  renderRow,
}: {
  rows: readonly RunMessageRow[];
  count: number;
  pending: boolean;
  renderRow: (row: RunMessageRow) => ReactNode;
}): JSX.Element {
  return (
    <Collapsible
      className="group/worker rounded-sw-card border border-sw-border bg-sw-surface/40"
      data-testid="agent-tool-transcript"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sw-xs text-sw-muted hover:text-sw-text">
        <span className="font-medium uppercase tracking-[0.06em]">transcript</span>
        <span data-testid="agent-tool-transcript-count">
          {count === 0
            ? pending
              ? "waiting for the first message"
              : "no messages"
            : `${count} ${count === 1 ? "message" : "messages"}`}
        </span>
        <span
          className="ml-auto text-[10px] opacity-60 transition group-data-[state=open]/worker:rotate-180"
          aria-hidden
        >
          ▾
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t border-sw-border px-3 py-2">
        {rows.length === 0 ? (
          <span className="text-sw-xs text-sw-muted">nothing persisted yet</span>
        ) : (
          rows.map(renderRow)
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

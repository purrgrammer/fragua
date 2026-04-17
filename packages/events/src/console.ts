// Console tee: prints a concise one-line summary per event as they arrive.
// Wraps another sink so the JSONL audit trail is always preserved.

import type { Event, EventSink } from "@swarm/core";

type Writer = (line: string) => void;

export interface ConsoleSinkOptions {
  /** Wrap another sink (events still flow to the JSONL file). */
  inner: EventSink;
  /** Output writer. Defaults to process.stderr so stdout stays machine-parseable. */
  writer?: Writer;
  /** 0 = quiet, 1 = default (pipeline+node+fail), 2 = verbose (includes tool calls + LLM start/done). */
  level?: 0 | 1 | 2;
}

const SYMBOLS: Partial<Record<Event["type"], string>> = {
  "pipeline.started": "▶",
  "pipeline.completed": "✓",
  "pipeline.failed": "✗",
  "node.started": "·",
  "node.completed": "✓",
  "node.failed": "✗",
  "edge.selected": "→",
  "tool.execution_start": "⚙",
  "tool.execution_end": "⚙",
  "llm.error": "!",
};

export class ConsoleSink implements EventSink {
  private readonly inner: EventSink;
  private readonly write: Writer;
  private readonly level: 0 | 1 | 2;

  /** Accumulated cost summary usable after close(). */
  readonly totals = { cost_usd: 0, input_tokens: 0, output_tokens: 0, calls: 0 };

  constructor(opts: ConsoleSinkOptions) {
    this.inner = opts.inner;
    this.write = opts.writer ?? ((line: string) => process.stderr.write(`${line}\n`));
    this.level = opts.level ?? 1;
  }

  async append(event: Event): Promise<void> {
    await this.inner.append(event);
    if (event.type === "cost.recorded") {
      const d = event.data as {
        cost_usd?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
      this.totals.cost_usd += Number(d.cost_usd ?? 0);
      this.totals.input_tokens += Number(d.input_tokens ?? 0);
      this.totals.output_tokens += Number(d.output_tokens ?? 0);
      this.totals.calls++;
    }
    if (this.level === 0) return;
    const line = formatEvent(event, this.level);
    if (line !== undefined) this.write(line);
  }

  async close(): Promise<void> {
    if (this.inner.close) await this.inner.close();
  }
}

function formatEvent(event: Event, level: 1 | 2): string | undefined {
  const sym = SYMBOLS[event.type] ?? " ";
  const tag = event.node_id ? `[${event.node_id}]` : "";
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case "pipeline.started":
      return `${sym} pipeline started`;
    case "pipeline.completed":
      return `${sym} pipeline completed`;
    case "pipeline.failed":
      return `${sym} pipeline FAILED — ${String(data["reason"] ?? "")}`;
    case "node.started":
      return `${sym} ${tag} started`;
    case "node.completed": {
      const outcome = data["outcome"] as { status?: string; failure_reason?: string; notes?: string } | undefined;
      const status = outcome?.status ?? "?";
      if (status === "fail") {
        return `✗ ${tag} FAILED — ${outcome?.failure_reason ?? outcome?.notes ?? ""}`;
      }
      return level >= 2 ? `${sym} ${tag} ${status}` : undefined;
    }
    case "node.failed":
      return `✗ ${tag} FAILED — ${String(data["reason"] ?? "")}`;
    case "node.retrying":
      return `↻ ${tag} retry ${String(data["attempt"] ?? "?")}/${String(data["max_retries"] ?? "?")} in ${String(data["delay_ms"] ?? "?")}ms`;
    case "edge.selected":
      return level >= 2 ? `  → ${String(data["to"] ?? "")}` : undefined;
    case "tool.execution_start":
      return level >= 2 ? `  ⚙ ${String(data["tool_name"] ?? "")}` : undefined;
    case "tool.execution_end":
      return level >= 2 && data["is_error"] === true ? `  ⚙ ${String(data["tool_name"] ?? "")} error` : undefined;
    case "llm.error":
      return `! ${tag} LLM error: ${String(data["message"] ?? "")}`;
    case "cost.recorded":
      return level >= 2
        ? `  $ ${(Number(data["cost_usd"] ?? 0)).toFixed(4)} — ${String(data["provider"] ?? "?")}/${String(
            data["model"] ?? "?",
          )} in=${String(data["input_tokens"] ?? 0)} out=${String(data["output_tokens"] ?? 0)}`
        : undefined;
    default:
      return undefined;
  }
}

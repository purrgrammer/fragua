// Single-line formatter for swarm events — used by the TUI stream pane.
// Mirrors the shape of `ConsoleSink.formatEvent` in @swarm/events but
// returns structured `{ text, color, dim }` instead of writing to a
// stream, so the TUI can paint with Ink's <Text color=...>.

import type { Event } from "@swarm/core";
import type { StreamLine } from "./StreamPane.tsx";

let nextId = 0;

/**
 * Format one event into a stream line, or `undefined` to skip (noisy
 * lifecycle events we don't care about: agent.start, agent.end, and
 * undecorated deltas).
 *
 * The output roughly matches the level-2 ("verbose") output of
 * `ConsoleSink` so users familiar with the `-v` flag see the same shape.
 */
export function formatEventLine(ev: Event): StreamLine | undefined {
  const tag = ev.node_id ? `[${ev.node_id}] ` : "";
  const d = (ev.data as Record<string, unknown> | undefined) ?? {};

  switch (ev.type) {
    case "pipeline.started":
      return line(`▶ pipeline started`, "cyan");
    case "pipeline.completed":
      return line(`✓ pipeline completed`, "green");
    case "pipeline.failed":
      return line(`✗ pipeline FAILED — ${String(d["reason"] ?? "")}`, "red");
    case "pipeline.canceled":
      return line(`⊘ pipeline canceled — ${String(d["reason"] ?? "")}`, "yellow");
    case "node.started":
      return line(`· ${tag}started`, "cyan");
    case "node.completed": {
      const outcome = d["outcome"] as { status?: string; failure_reason?: string; notes?: string } | undefined;
      const status = outcome?.status ?? "?";
      if (status === "fail") return line(`✗ ${tag}FAILED — ${outcome?.failure_reason ?? outcome?.notes ?? ""}`, "red");
      return line(`✓ ${tag}${status}`, "green");
    }
    case "node.failed":
      return line(`✗ ${tag}FAILED — ${String(d["reason"] ?? "")}`, "red");
    case "node.retrying": {
      const attempt = typeof d["attempt"] === "number" ? (d["attempt"] as number) + 1 : "?";
      const total = typeof d["max_retries"] === "number" ? (d["max_retries"] as number) + 1 : "?";
      return line(`↻ ${tag}attempt ${attempt}/${total} in ${String(d["delay_ms"] ?? "?")}ms`, "yellow");
    }
    case "edge.selected":
      return dimLine(`→ ${String(d["to"] ?? "")}`);
    case "llm.start":
      return dimLine(`${tag}llm.start ${String(d["model"] ?? "")}`);
    case "llm.text_delta": {
      const delta = String(d["delta"] ?? "");
      if (!delta) return undefined;
      // Keep deltas short — terminal width isn't ours to know here.
      const squashed = delta.replace(/\s+/g, " ").slice(0, 160);
      return dimLine(`  ${squashed}`);
    }
    case "llm.thinking_delta":
      // Thinking deltas are high-volume and noisy in a list view; just
      // summarise the first event per turn by dropping the rest.
      return undefined;
    case "llm.error":
      return line(`! ${tag}LLM error: ${String(d["message"] ?? "")}`, "red");
    case "tool.execution_start":
      return line(`⚙ ${tag}${String(d["tool_name"] ?? "")}`, "blue");
    case "tool.execution_end":
      if (d["is_error"] === true) return line(`⚙ ${tag}${String(d["tool_name"] ?? "")} error`, "red");
      return dimLine(`⚙ ${tag}${String(d["tool_name"] ?? "")} ok`);
    case "cost.recorded": {
      const cost = Number(d["cost_usd"] ?? 0);
      const ins = Number(d["input_tokens"] ?? 0);
      const outs = Number(d["output_tokens"] ?? 0);
      const model = String(d["model"] ?? "?");
      return dimLine(`  $${cost.toFixed(4)} ${model} in=${ins} out=${outs}`);
    }
    case "control.requested": {
      const cmd = String(d["command"] ?? "?");
      return line(`⌂ control.${cmd}`, "yellow");
    }
    case "control.applied":
      return line(`⌂ control.applied ${String(d["command"] ?? "")}`, "yellow");
    case "steering.injected": {
      const msg = String((d as { message?: unknown }).message ?? "");
      return line(`» steer: ${msg.slice(0, 140)}`, "yellow");
    }
    default:
      return undefined;
  }
}

function line(text: string, color?: string): StreamLine {
  nextId += 1;
  return color !== undefined ? { id: nextId, text, color } : { id: nextId, text };
}

function dimLine(text: string): StreamLine {
  nextId += 1;
  return { id: nextId, text, dim: true };
}

import { outputValueId, renderOutputValue } from "@fragua/core";
import type { RunMessageRow } from "./api.ts";

const OUTPUT_TAG = /<(\/?)fragua_output_[0-9a-f]{64}>/g;
const OUTPUT_BLOCK = /<fragua_output_([0-9a-f]{64})>([\s\S]*?)<\/fragua_output_\1>/g;

/** Unwrap `<fragua_output_<sha256>>…</fragua_output_<sha256>>` boundary tags so
 * a substituted prompt reads as the value it carries. The tags exist for the
 * model (the system prompt marks them as data, not instructions); a person
 * reading the conversation only wants the content. */
export function stripOutputTags(text: string): string {
  return text.replace(OUTPUT_TAG, "");
}

/** `start` is the segment's character offset in the prompt: a stable key for
 * rendering that does not depend on array position. */
export type PromptSegment =
  | { kind: "text"; text: string; start: number }
  | { kind: "output"; id: string; value: string; start: number };

/** Split a substituted prompt into prose and the values that were
 * interpolated into it, in order. A tag whose closing pair is missing is left
 * as prose, unwrapped. */
export function splitOutputTags(text: string): PromptSegment[] {
  const out: PromptSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(OUTPUT_BLOCK)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: stripOutputTags(text.slice(last, start)), start: last });
    out.push({ kind: "output", id: m[1] ?? "", value: m[2] ?? "", start });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: stripOutputTags(text.slice(last)), start: last });
  return out;
}

/** Where a substituted value came from: the producing node and the dotted
 * path read from its struct (`shortlist.picks`, `scope.pr.number`). */
export interface OutputProducer {
  nodeId: string;
  path: string;
}

/** Index every value the run's producers emitted, by the boundary-tag id the
 * substitution would give it. Producers are `tool_node` rows carrying
 * `outputs` and assistant `emit_output` calls; each field and every dotted
 * sub-record is indexed, since a prompt can read any of them. */
export function buildOutputIndex(messages: RunMessageRow[]): Map<string, OutputProducer> {
  const index = new Map<string, OutputProducer>();
  for (const row of messages) {
    const nodeId = row.nodeId;
    if (nodeId == null) continue;
    const msg = row.content;
    if (msg.role === "tool_node" && msg.outputs) {
      indexStruct(index, nodeId, msg.outputs);
    } else if (msg.role === "assistant") {
      for (const chunk of msg.content) {
        if (chunk.type === "toolCall" && chunk.name === "emit_output" && isRecord(chunk.arguments)) {
          indexStruct(index, nodeId, chunk.arguments);
        }
      }
    }
  }
  return index;
}

function indexStruct(index: Map<string, OutputProducer>, nodeId: string, struct: Record<string, unknown>): void {
  const walk = (val: unknown, path: string[]): void => {
    if (val === undefined || val === null) return;
    const id = outputValueId(renderOutputValue(val as Parameters<typeof renderOutputValue>[0]));
    // First producer wins: a later re-emission of the same bytes is the same value.
    if (!index.has(id)) index.set(id, { nodeId, path: path.join(".") });
    if (isRecord(val)) for (const [k, v] of Object.entries(val)) walk(v, [...path, k]);
  };
  for (const [k, v] of Object.entries(struct)) walk(v, [k]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Pretty-print a value for display when it is JSON; otherwise return null so
 * the caller shows it as text. */
export function prettyJson(value: string): string | null {
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

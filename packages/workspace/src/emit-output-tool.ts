// `emit_output` tool \u2014 the codergen agent's first-class structured
// output emitter.
//
// Calling `emit_output({ data })` writes `data` into the per-turn slot
// `swarmContext.pendingOutput.value` (initialised by the codergen
// backend). After the agent loop returns idle, the backend reads the
// slot and surfaces it via `Outcome.pendingOutput`; handler-bridge
// then writes `JSON.stringify(data)` as the node's `output` artifact
// and flags `HandlerResult.transition.outputEmitted` so
// `result-to-facts` emits `fact.output_emitted { source: \"agent\", \u2026 }`
// next to `fact.node_completed`.
//
// When the node declares `output_schema`, this tool validates `data`
// against it synchronously via `Value.Check` from
// `@sinclair/typebox/value`. Validation failure surfaces as an
// `is_error: true` toolResult with structured `errors[]` so the LLM
// can retry within the same turn. Repeated failures do not halt the
// node \u2014 only a missing `emit_output` call at turn end (with\n// `output_schema` set) downgrades the outcome to fail.\n//\n// Always available on every codergen call. Wiring lives in
// `packages/agent/src/backend.ts` \u2014 even when a node pins
// `allowed_tools` or lists `emit_output` under `denied_tools`, the
// backend force-includes this tool. Built-in is built-in.
//
// See docs/proposals/codergen-context-output-tools.md \u00a72.2 / \u00a73.

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Tool } from "./types.ts";

export interface EmitOutputToolArgs {
  data: unknown;
}

export interface EmitOutputToolData {
  ok: boolean;
  errors?: Array<{ path: string; message: string }>;
}

export const emitOutputTool: Tool<EmitOutputToolArgs, EmitOutputToolData> = {
  name: "emit_output",
  description:
    "Emit this node's structured output. Downstream nodes reference it via $<this-node>.output \u2014 and, if data is an object or array, can traverse specific fields via JSON path (e.g. $classify.output.label).\n\nCall this tool exactly once. If you call it multiple times, the last call wins. If this node declares output_schema and you do not call emit_output, the node is treated as failed.\n\nWhen no output_schema is declared, not calling this tool is fine \u2014 the node's output falls back to your final assistant text. Prefer emit_output whenever you are producing structured data.\n\ndata may be a string, a JSON object, or a JSON array.",
  parameters: Type.Object(
    {
      data: Type.Union(
        [
          Type.String(),
          Type.Record(Type.String(), Type.Unknown()),
          Type.Array(Type.Unknown()),
        ],
        { description: "The structured output to emit. String, JSON object, or JSON array." },
      ),
    },
    { additionalProperties: false },
  ),
  idempotent: true,
  truncation: { max_chars: 4_000, mode: "tail" },
  async execute(args, _env, opts) {
    const slot = opts?.swarmContext?.pendingOutput;
    if (!slot) {
      return {
        text: "emit_output: backend not wired (swarmContext.pendingOutput is missing)",
        is_error: true,
        data: { ok: false },
      };
    }
    const schema = opts?.swarmContext?.outputSchema;
    if (schema !== undefined && schema !== null) {
      // biome-ignore lint/suspicious/noExplicitAny: schema is an opaque user-supplied JSON Schema.
      const checked = Value.Check(schema as any, args.data);
      if (!checked) {
        // biome-ignore lint/suspicious/noExplicitAny: same as above.
        const errors = [...Value.Errors(schema as any, args.data)].map((e) => ({
          path: e.path,
          message: e.message,
        }));
        return {
          text: `emit_output: data failed schema validation (${errors.length} error${
            errors.length === 1 ? "" : "s"
          }). Correct the value and call again.`,
          is_error: true,
          data: { ok: false, errors },
        };
      }
    }
    slot.value = { data: args.data };
    return {
      text: "emit_output recorded.",
      data: { ok: true },
    };
  },
};

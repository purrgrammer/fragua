// `context_set` tool \u2014 the codergen agent's first-class routing-context
// writer.
//
// Calling `context_set({ key, value })` populates a per-turn map on
// `swarmContext.contextWrites` (initialised by the codergen backend).
// After the agent loop returns idle, the backend drains the map into
// `Outcome.contextWrites`; handler-bridge merges it into the result's
// `routingDelta` and threads a `contextWriteLog` through to
// `result-to-facts`, which emits one `fact.context_written { source:\n// \"agent\", \u2026 }` per write next to `fact.node_completed`.
//
// Always available on every codergen call. Wiring lives in
// `packages/agent/src/backend.ts` \u2014 even when a node pins
// `allowed_tools` or lists `context_set` under `denied_tools`, the
// backend force-includes this tool. Built-in is built-in.
//
// See docs/proposals/codergen-context-output-tools.md \u00a72.1.

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.ts";

export interface ContextSetToolArgs {
  key: string;
  value: string | number | boolean | null;
}

export interface ContextSetToolData {
  ok: boolean;
  key: string;
  value?: string | number | boolean | null;
  error?: string;
}

export const contextSetTool: Tool<ContextSetToolArgs, ContextSetToolData> = {
  name: "context_set",
  description:
    'Set a routing-context key so downstream nodes and edge conditions can read it via context.<key>. Use this when you have classified the input, chosen a branch, scored an outcome, or computed any value the rest of the workflow needs.\n\nYou may call this tool multiple times in a single turn to set multiple keys. Each call is additive; the last write to a given key wins.\n\nRules:\n- key must be a single identifier \u2014 no dots (e.g. "severity", not "issue.severity").\n- value must be a string, number, boolean, or null. Objects and arrays are not supported yet.\n\nExample: context_set({ key: "category", value: "billing" })',
  parameters: Type.Object(
    {
      key: Type.String({
        description: "Routing-context key. Single identifier; must not contain a dot.",
      }),
      value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()], {
        description: "Scalar value. Objects and arrays are not supported in v1.",
      }),
    },
    { additionalProperties: false },
  ),
  idempotent: true,
  truncation: { max_chars: 1_000, mode: "tail" },
  async execute(args, _env, opts) {
    if (typeof args.key !== "string" || args.key.length === 0) {
      return {
        text: "context_set: key must be a non-empty string",
        is_error: true,
        data: { ok: false, key: String(args.key ?? ""), error: "key must be a non-empty string" },
      };
    }
    if (args.key.includes(".")) {
      return {
        text: `context_set: key "${args.key}" contains a dot; use a single identifier (no dots)`,
        is_error: true,
        data: { ok: false, key: args.key, error: "key must not contain a dot" },
      };
    }
    if (
      args.value !== null &&
      typeof args.value !== "string" &&
      typeof args.value !== "number" &&
      typeof args.value !== "boolean"
    ) {
      return {
        text: `context_set: value must be string, number, boolean, or null (got ${typeof args.value})`,
        is_error: true,
        data: { ok: false, key: args.key, error: "value must be a scalar or null" },
      };
    }
    const sink = opts?.swarmContext?.contextWrites;
    if (!sink) {
      // No backend wiring \u2014 surface as a tool error so the LLM sees the
      // failure rather than silently writing into the void.
      return {
        text: "context_set: backend not wired (swarmContext.contextWrites is missing)",
        is_error: true,
        data: { ok: false, key: args.key, error: "backend not wired" },
      };
    }
    const prev = sink.get(args.key);
    sink.set(args.key, {
      value: args.value,
      ...(prev !== undefined ? { prevValue: prev.value } : {}),
    });
    return {
      text: `context.${args.key} = ${JSON.stringify(args.value)}`,
      data: { ok: true, key: args.key, value: args.value },
    };
  },
};

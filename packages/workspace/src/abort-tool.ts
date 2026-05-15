// `abort` tool — the universal self-abort signal for codergen agents.
//
// An agent that cannot proceed (missing target, contradictory
// constraints, external blocker) calls `abort` instead of producing an
// output. The call halts the run: the backend scans the transcript for
// it and turns it into a non-retryable `fail` outcome, which workflows
// wire with `condition="outcome=fail"`.
//
// Always available on every codergen call. Wiring lives in
// `packages/agent/src/backend.ts` — even when a node pins
// `allowed_tools` or lists `abort` under `denied_tools`, the backend
// force-includes this tool. Built-in is built-in.
//
// `execute` is inert: it returns a confirmation plus `terminate: true`
// so pi-agent-core stops the loop after the tool batch. The reason the
// backend surfaces is read straight off the tool-call arguments, not
// from this return value.

import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.ts";

export interface AbortToolArgs {
  reason: string;
}

export interface AbortToolData {
  reason: string;
}

export const abortTool: Tool<AbortToolArgs, AbortToolData> = {
  name: "abort",
  description:
    "Abort the run when the task cannot proceed — a missing target, contradictory constraints, or an external blocker. `reason` is one short sentence; it is surfaced as the run's failure reason. Calling `abort` ends the run immediately and non-retryably. Do not call it for normal completion — just produce your output.",
  parameters: Type.Object(
    {
      reason: Type.String({
        description: "One short sentence explaining why the task cannot proceed. Surfaced as the run's failure reason.",
      }),
    },
    { additionalProperties: false },
  ),
  idempotent: true,
  truncation: { max_chars: 1_000, mode: "tail" },
  async execute(args) {
    return {
      text: `Run aborted: ${args.reason}`,
      terminate: true,
      data: { reason: args.reason },
    };
  },
};

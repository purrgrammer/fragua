// Per-handler metadata-relevance predicates. Single source of truth for
// "what fields make sense to surface on this node?" — used by the
// GraphView card body AND the NodeInspector drawer so the two stay in
// lockstep when the matrix shifts.
//
// The matrix:
//
//   handler            | LLM cfg? | retries? | tool_command?
//   -------------------|----------|----------|---------------
//   llm                |  yes     |  yes     |  no
//   conditional        |  no*     |  yes     |  no
//   human              |  no      |  yes     |  no
//   tool               |  no      |  yes     |  yes
//   start / exit       |  no      |  no      |  no
//
// *conditional doesn't call an LLM today; the matrix collapses
//  it into the "no LLM" bucket so the cascade-resolved model
//  doesn't render and mislead.

import type { NodeAttrs } from "@fragua/core";

/** True when the handler will issue an LLM call at runtime, which is the
 *  only case where `model` / `provider` / `reasoning_effort` /
 *  `thread_id` are operationally meaningful. */
export function showsLlm(handler: string, _attrs: NodeAttrs | undefined): boolean {
  return handler === "llm";
}

/** True when the handler can be retried by the executor — i.e. it
 *  benefits from a `max_retries` / `retry_policy` / `retry_target`
 *  readout. start / exit are pure lifecycle markers. */
export function canRetry(handler: string): boolean {
  return handler !== "start" && handler !== "exit";
}

/** start / exit are pure lifecycle markers — no metadata, no LLM, no
 *  retries — and render compactly in the card. */
export function isStructural(handler: string): boolean {
  return handler === "start" || handler === "exit";
}

// Per-handler metadata-relevance predicates. Single source of truth for
// "what fields make sense to surface on this node?" — used by the
// GraphView card body AND the NodeInspector drawer so the two stay in
// lockstep when the matrix shifts.
//
// The matrix:
//
//   handler            | LLM cfg? | retries? | tool_command? | fan_in cfg?
//   -------------------|----------|----------|---------------|------------
//   llm           |  yes     |  yes     |  no           |  no
//   conditional        |  no*     |  yes     |  no           |  no
//   wait.human         |  no      |  yes     |  no           |  no
//   tool               |  no      |  yes     |  yes          |  no
//   parallel           |  no      |  no      |  no           |  yes
//   parallel.fan_in    |  iff prompt set     |  yes     |  no  |  yes
//   start / exit       |  no      |  no      |  no           |  no
//
// *conditional doesn't call an LLM today; the matrix collapses
//  it into the "no LLM" bucket so the cascade-resolved model
//  doesn't render and mislead.

import type { NodeAttrs } from "@swarm/core";

/** True when the handler will issue an LLM call at runtime, which is the
 *  only case where `model` / `provider` / `reasoning_effort` /
 *  `thread_id` are operationally meaningful. parallel.fan_in is the
 *  borderline case: it's LLM-driven only when the author wrote a
 *  `prompt` (otherwise the heuristic ranker runs and the model attrs
 *  are dead config). */
export function showsLlm(handler: string, attrs: NodeAttrs | undefined): boolean {
  if (handler === "llm") return true;
  if (handler === "parallel.fan_in") {
    return typeof attrs?.prompt === "string" && attrs.prompt.trim() !== "";
  }
  return false;
}

/** True when the handler can be retried by the executor — i.e. it
 *  benefits from a `max_retries` / `retry_policy` / `retry_target`
 *  readout. start / exit are pure lifecycle markers; `parallel` is a
 *  structural fan-out (the branches retry, not the component). */
export function canRetry(handler: string): boolean {
  return handler !== "start" && handler !== "exit" && handler !== "parallel";
}

/** parallel.fan_in nodes only — `"prompt"` when an LLM ranker is wired,
 *  `"heuristic"` otherwise. Returns `undefined` for any other handler. */
export function fanInRank(handler: string, attrs: NodeAttrs | undefined): "prompt" | "heuristic" | undefined {
  if (handler !== "parallel.fan_in") return undefined;
  return typeof attrs?.prompt === "string" && attrs.prompt.trim() !== "" ? "prompt" : "heuristic";
}

/** start / exit are pure lifecycle markers — no metadata, no LLM, no
 *  retries — and render compactly in the card. */
export function isStructural(handler: string): boolean {
  return handler === "start" || handler === "exit";
}

// Workflow-load model validator.
//
// Walks every node in a parsed DOT workflow and rejects those whose
// declared `(provider, model)` pair does not resolve in the pi-ai
// registry. Catches the `claude-sonnet-4-6` (hyphen form) typo that
// silently runs a plan node, then halts on the first downstream LLM
// dispatch — wasting real tokens before the misconfiguration surfaces.
//
// Provider resolution rules for a node:
//   - Both `provider` and `model` set → resolve strictly; reject if
//     the pair doesn't exist in pi-ai.
//   - Only `model` set → the runtime falls back to
//     `defaultModel.provider` which isn't known at workflow-load time.
//     Best-effort: accept the model if it resolves under ANY known
//     provider; reject only when no known provider recognises it.
//   - Neither set → skip (the daemon's default is applied at runtime).
//
// Codergen nodes only — other handler kinds (start/exit/tool/wait.human/
// conditional/parallel) don't LLM-dispatch.

import { parseDotSource } from "@swarm/core";
import { KNOWN_PROVIDERS } from "./providers.ts";
import { resolveModelOrNull } from "./providers.ts";

export interface ModelOffender {
  nodeId: string;
  provider?: string;
  model: string;
  reason: string;
}

export type WorkflowModelValidationResult = { ok: true } | { ok: false; offenders: ModelOffender[] };

/** Validate a DOT workflow's codergen-node model declarations. */
export function validateWorkflowModels(dotSource: string): WorkflowModelValidationResult {
  let graph: ReturnType<typeof parseDotSource>;
  try {
    graph = parseDotSource(dotSource);
  } catch {
    // If the DOT itself can't be parsed, let the downstream parse-time
    // error surface elsewhere — don't fake model offenders for it.
    return { ok: true };
  }

  const offenders: ModelOffender[] = [];

  for (const node of Object.values(graph.nodes)) {
    // Only codergen (box) nodes dispatch to an LLM. The other shapes
    // don't accept provider/model attrs meaningfully.
    if (node.shape !== "box") continue;

    const model = typeof node.attrs.model === "string" ? node.attrs.model : undefined;
    const provider = typeof node.attrs.provider === "string" ? node.attrs.provider : undefined;
    if (!model) continue; // falls back to daemon default at runtime

    if (provider) {
      if (resolveModelOrNull(provider, model) == null) {
        offenders.push({
          nodeId: node.id,
          provider,
          model,
          reason: `unknown model "${provider}/${model}" in pi-ai registry`,
        });
      }
      continue;
    }

    // No provider declared — accept if ANY known provider recognises the
    // model. This is lenient on purpose: stricter enforcement would
    // require a daemon-default-provider coupling we don't want in this
    // layer.
    const acceptedBy = KNOWN_PROVIDERS.find((p) => resolveModelOrNull(p.name, model) != null);
    if (acceptedBy == null) {
      offenders.push({
        nodeId: node.id,
        model,
        reason: `model "${model}" does not resolve under any known provider (${KNOWN_PROVIDERS.map((p) => p.name).join(", ")})`,
      });
    }
  }

  if (offenders.length === 0) return { ok: true };
  return { ok: false, offenders };
}

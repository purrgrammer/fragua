// Workflow-load model validator.
//
// Walks every node in a parsed DOT workflow and rejects those whose
// declared `(provider, model)` pair does not resolve in the ModelRegistry
// (pi-ai built-ins + any custom providers in models.json). Catches the
// `claude-sonnet-4-6` (hyphen form) typo that silently runs a plan node,
// then halts on the first downstream LLM dispatch — wasting real tokens
// before the misconfiguration surfaces.
//
// Provider resolution rules for a node:
//   - Both `provider` and `model` set → resolve strictly; reject if
//     the pair doesn't exist in the registry.
//   - Only `model` set → the runtime falls back to the daemon default
//     provider which isn't known at workflow-load time. Best-effort:
//     accept the model if it resolves under ANY provider in the
//     registry; reject only when no provider recognises it.
//   - Neither set → skip (the daemon's default is applied at runtime).
//
// Codergen nodes only — other handler kinds (start/exit/tool/wait.human/
// conditional/parallel) don't LLM-dispatch.

import { parseDotSource } from "@swarm/core";
import type { ModelRegistry } from "./credentials/index.ts";
import { AuthStorage, findByBareId, ModelRegistry as Registry } from "./credentials/index.ts";

export interface ModelOffender {
  nodeId: string;
  provider?: string;
  model: string;
  reason: string;
}

export type WorkflowModelValidationResult = { ok: true } | { ok: false; offenders: ModelOffender[] };

/** Lazy process-wide registry used when the caller didn't pass one.
 * Covers legacy call sites (validate command, tests) without forcing
 * them to construct + pass a registry they don't otherwise need. */
let cachedRegistry: ModelRegistry | undefined;
function getDefaultRegistry(): ModelRegistry {
  if (!cachedRegistry) cachedRegistry = Registry.create(AuthStorage.create());
  return cachedRegistry;
}

/** Validate a DOT workflow's codergen-node model declarations. */
export function validateWorkflowModels(
  dotSource: string,
  registry: ModelRegistry = getDefaultRegistry(),
): WorkflowModelValidationResult {
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
    if (node.shape !== "box") continue;

    const model = typeof node.attrs.model === "string" ? node.attrs.model : undefined;
    const provider = typeof node.attrs.provider === "string" ? node.attrs.provider : undefined;
    if (!model) continue;

    if (provider) {
      if (registry.find(provider, model) == null) {
        offenders.push({
          nodeId: node.id,
          provider,
          model,
          reason: `unknown model "${provider}/${model}" in pi-ai registry`,
        });
      }
      continue;
    }

    if (findByBareId(registry, model) == null) {
      const knownProviders = new Set(registry.getAll().map((m) => m.provider));
      offenders.push({
        nodeId: node.id,
        model,
        reason: `model "${model}" does not resolve under any known provider (${[...knownProviders].sort().join(", ")})`,
      });
    }
  }

  if (offenders.length === 0) return { ok: true };
  return { ok: false, offenders };
}

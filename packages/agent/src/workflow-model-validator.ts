// Workflow-load model validator.
//
// Walks every node in a parsed workflow and rejects those whose
// declared `(provider, model)` pair does not resolve in the ModelRegistry
// (pi-ai built-ins + any custom providers in the `provider_config`
// table on the global fragua store). Catches the
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
// Llm nodes only — other handler kinds (start/exit/tool/human)
// don't LLM-dispatch.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import type { ModelRegistry } from "./credentials/index.ts";
import { AuthStorage, findByBareId, getFraguaHome, ModelRegistry as Registry } from "./credentials/index.ts";

export interface ModelOffender {
  nodeId: string;
  provider?: string;
  model: string;
  reason: string;
}

export type WorkflowModelValidationResult = { ok: true } | { ok: false; offenders: ModelOffender[] };

/** Lazy process-wide registry used when the caller didn't pass one.
 * Covers legacy call sites (validate command, tests) without forcing
 * them to construct + pass a registry they don't otherwise need. The
 * paired store handle is opened against the global fragua DB; it lives
 * for the process lifetime. The store is also the source of
 * custom-provider definitions (`provider_config` table). */
let cachedRegistry: ModelRegistry | undefined;
let cachedStore: SqliteStore | undefined;
function getDefaultRegistry(): ModelRegistry {
  if (!cachedRegistry) {
    if (!cachedStore) {
      const home = getFraguaHome();
      mkdirSync(home, { recursive: true });
      cachedStore = new SqliteStore({ path: join(home, "fragua.db") });
    }
    cachedRegistry = Registry.create(AuthStorage.fromStore(cachedStore), cachedStore);
  }
  return cachedRegistry;
}

/** Validate a workflow's llm-node model declarations. */
export function validateWorkflowModels(
  source: string,
  registry: ModelRegistry = getDefaultRegistry(),
): WorkflowModelValidationResult {
  let graph: ReturnType<typeof parseWorkflow>;
  try {
    graph = parseWorkflow(source);
  } catch {
    // If the workflow itself can't be parsed, let the downstream parse-time
    // error surface elsewhere — don't fake model offenders for it.
    return { ok: true };
  }

  const offenders: ModelOffender[] = [];

  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "llm") continue;

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

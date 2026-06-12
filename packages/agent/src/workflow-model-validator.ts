// Workflow model validators.
//
// Two checks over a parsed workflow's llm-node `(provider, model)`
// declarations:
//
//   - `validateWorkflowModels(source, registry)` — the authoritative
//     enqueue-time check against a store-backed `ModelRegistry`
//     (pi-ai built-ins + custom providers from the `provider_config`
//     table). An unresolvable pair is a hard error.
//
//   - `validateWorkflowModelsOffline(source)` — a store-free check
//     against the bundled pi-ai registry only (`getProviders` +
//     `getModels`, i.e. models.generated). Used by `fragua validate`,
//     which must never open the store (CI / editor contexts). A model
//     id absent from the offline registry might be a custom model
//     registered only in a store, so absence is a *warning* — the
//     authoritative check happens at enqueue. The exception is a
//     near-miss of a known id (normalised compare catches the
//     `claude-sonnet-4-6` vs `claude-sonnet-4.6` typo class), which is
//     a known-bad declaration and stays an error.
//
// Provider resolution rules for a node:
//   - Both `provider` and `model` set → resolve strictly under that
//     provider.
//   - Only `model` set → the runtime falls back to the daemon default
//     provider which isn't known at workflow-load time. Best-effort:
//     accept the model if it resolves under ANY provider.
//   - Neither set → skip (the daemon's default is applied at runtime).
//
// Llm nodes only — other handler kinds (start/exit/tool/human)
// don't LLM-dispatch.

import { type Api, getModels, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import { parseWorkflow } from "@fragua/core";
import type { ModelRegistry } from "./credentials/index.ts";
import { findByBareId } from "./credentials/index.ts";

export interface ModelOffender {
  nodeId: string;
  provider?: string;
  model: string;
  reason: string;
}

export type WorkflowModelValidationResult = { ok: true } | { ok: false; offenders: ModelOffender[] };

export interface OfflineModelDiagnostic {
  nodeId: string;
  provider?: string;
  model: string;
  severity: "error" | "warning";
  reason: string;
}

export interface OfflineModelCheckResult {
  offenders: OfflineModelDiagnostic[];
}

interface ModelDeclaration {
  nodeId: string;
  model: string;
  provider: string | undefined;
}

/** Walk a workflow's llm nodes and pull out their model declarations.
 * Returns undefined when the source doesn't parse — parse-time errors
 * surface elsewhere; don't fake model offenders for them. */
function collectModelDeclarations(source: string): ModelDeclaration[] | undefined {
  let graph: ReturnType<typeof parseWorkflow>;
  try {
    graph = parseWorkflow(source);
  } catch {
    return undefined;
  }
  const declarations: ModelDeclaration[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "llm") continue;
    const model = typeof node.attrs.model === "string" ? node.attrs.model : undefined;
    const provider = typeof node.attrs.provider === "string" ? node.attrs.provider : undefined;
    if (!model) continue;
    declarations.push({ nodeId: node.id, model, provider });
  }
  return declarations;
}

/** Validate a workflow's llm-node model declarations against a
 * store-backed registry. The authoritative enqueue-time gate. */
export function validateWorkflowModels(source: string, registry: ModelRegistry): WorkflowModelValidationResult {
  const declarations = collectModelDeclarations(source);
  if (declarations === undefined) return { ok: true };

  const offenders: ModelOffender[] = [];

  for (const { nodeId, model, provider } of declarations) {
    if (provider) {
      if (registry.find(provider, model) == null) {
        offenders.push({
          nodeId,
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
        nodeId,
        model,
        reason: `model "${model}" does not resolve under any known provider (${[...knownProviders].sort().join(", ")})`,
      });
    }
  }

  if (offenders.length === 0) return { ok: true };
  return { ok: false, offenders };
}

/** Hyphen/dot/underscore-insensitive compare key. Catches the typo
 * class where a real model id is declared with the wrong separator. */
function normaliseId(id: string): string {
  return id.toLowerCase().replace(/[._]/g, "-");
}

interface OfflineIndex {
  byProvider: Map<string, Model<Api>[]>;
  all: Model<Api>[];
}

function buildOfflineIndex(): OfflineIndex {
  const byProvider = new Map<string, Model<Api>[]>();
  const all: Model<Api>[] = [];
  for (const provider of getProviders()) {
    const models = getModels(provider as KnownProvider) as Model<Api>[];
    byProvider.set(provider, models);
    all.push(...models);
  }
  return { byProvider, all };
}

function findNearMiss(candidates: Model<Api>[], modelId: string): Model<Api> | undefined {
  const wanted = normaliseId(modelId);
  return candidates.find((m) => normaliseId(m.id) === wanted);
}

/** Validate a workflow's llm-node model declarations against the
 * bundled offline pi-ai registry only. Never opens the store; safe in
 * CI and editor contexts. Unknown ids warn (they may be custom models
 * known only to a store) — the authoritative check is at enqueue. */
export function validateWorkflowModelsOffline(source: string): OfflineModelCheckResult {
  const declarations = collectModelDeclarations(source);
  if (declarations === undefined) return { offenders: [] };

  const index = buildOfflineIndex();
  const offenders: OfflineModelDiagnostic[] = [];

  for (const { nodeId, model, provider } of declarations) {
    if (provider) {
      const providerModels = index.byProvider.get(provider);
      if (providerModels === undefined) {
        offenders.push({
          nodeId,
          provider,
          model,
          severity: "warning",
          reason: `provider "${provider}" is not in the bundled pi-ai registry; custom providers are authoritatively checked at enqueue`,
        });
        continue;
      }
      if (providerModels.some((m) => m.id === model)) continue;
      const nearMiss = findNearMiss(providerModels, model);
      if (nearMiss) {
        offenders.push({
          nodeId,
          provider,
          model,
          severity: "error",
          reason: `unknown model "${provider}/${model}" — did you mean "${provider}/${nearMiss.id}"?`,
        });
      } else {
        offenders.push({
          nodeId,
          provider,
          model,
          severity: "warning",
          reason: `model "${provider}/${model}" is not in the bundled pi-ai registry; custom models are authoritatively checked at enqueue`,
        });
      }
      continue;
    }

    if (index.all.some((m) => m.id === model)) continue;
    const nearMiss = findNearMiss(index.all, model);
    if (nearMiss) {
      offenders.push({
        nodeId,
        model,
        severity: "error",
        reason: `unknown model "${model}" — did you mean "${nearMiss.provider}/${nearMiss.id}"?`,
      });
    } else {
      offenders.push({
        nodeId,
        model,
        severity: "warning",
        reason: `model "${model}" is not in the bundled pi-ai registry; custom models are authoritatively checked at enqueue`,
      });
    }
  }

  return { offenders };
}

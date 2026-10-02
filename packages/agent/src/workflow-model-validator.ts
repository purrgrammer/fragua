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
//
// Judge nodes get their own pair below (`validateWorkflowJudgeProviders` /
// `…Offline`). They live here rather than in `core`'s graph validator because
// the answer depends on `provider_config` rows, and that validator is pure by
// design. Model MEMBERSHIP is deliberately unchecked: a local runtime's model
// list changes under `ollaya pull` mid-session, so a static check would
// manufacture failures. An unserved model is an honest runtime node fail.

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { JUDGE_DEFAULT_PROVIDER, parseWorkflow } from "@fragua/core";
import { JUDGE_BUILTIN_PROVIDERS, type JudgeProviderRecord } from "@fragua/core/handler";
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
    const models = getModels(provider) as Model<Api>[];
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

// ---------------------------------------------------------------------------
// Judge nodes
// ---------------------------------------------------------------------------

/** E055 — `provider:` names a backend no record is configured for.
 *  E056 — the resolved backend declares no default model and the step names
 *  none. Model ids do not cross providers, so there is nothing to fall back
 *  to. */
export interface JudgeProviderDiagnostic {
  nodeId: string;
  code: "E055" | "E056";
  severity: "error" | "warning";
  message: string;
}

interface JudgeDeclaration {
  nodeId: string;
  provider: string | undefined;
  model: string | undefined;
}

function collectJudgeDeclarations(source: string): JudgeDeclaration[] | undefined {
  let graph: ReturnType<typeof parseWorkflow>;
  try {
    graph = parseWorkflow(source);
  } catch {
    return undefined;
  }
  const out: JudgeDeclaration[] = [];
  for (const node of Object.values(graph.nodes)) {
    if (node.type !== "judge") continue;
    out.push({
      nodeId: node.id,
      provider: typeof node.attrs.provider === "string" ? node.attrs.provider : undefined,
      model: typeof node.attrs.model === "string" ? node.attrs.model : undefined,
    });
  }
  return out;
}

function checkJudge(
  source: string,
  providers: Readonly<Record<string, JudgeProviderRecord>>,
  defaultProvider: string,
  unknownProviderSeverity: "error" | "warning",
): JudgeProviderDiagnostic[] {
  const declarations = collectJudgeDeclarations(source);
  if (declarations === undefined) return [];
  const known = Object.keys(providers).sort().join(", ");
  const out: JudgeProviderDiagnostic[] = [];
  for (const { nodeId, provider, model } of declarations) {
    const id = provider ?? defaultProvider;
    const record = providers[id];
    if (record === undefined) {
      out.push({
        nodeId,
        code: "E055",
        severity: unknownProviderSeverity,
        message:
          unknownProviderSeverity === "error"
            ? `judge step "${nodeId}" names provider "${id}", which has no record (known: ${known})`
            : `judge step "${nodeId}" names provider "${id}", which is not built in; a \`judge:${id}\` config row is checked at enqueue`,
      });
      continue;
    }
    if (model === undefined && record.defaultModel === undefined) {
      out.push({
        nodeId,
        code: "E056",
        severity: "error",
        message: `judge step "${nodeId}": provider "${id}" declares no default model — set \`model:\` on the step`,
      });
    }
  }
  return out;
}

/** The authoritative enqueue-time check, against the store's merged records. */
export function validateWorkflowJudgeProviders(
  source: string,
  providers: Readonly<Record<string, JudgeProviderRecord>>,
  defaultProvider: string,
): JudgeProviderDiagnostic[] {
  return checkJudge(source, providers, defaultProvider, "error");
}

/** The store-free variant behind `fragua validate`. Only the built-ins are
 * visible, so an unknown provider warns rather than fails — it may be a
 * `judge:<id>` row this process cannot see. A provider that IS known and
 * declares no default model is still a hard error: that one needs no store. */
export function validateWorkflowJudgeProvidersOffline(
  source: string,
  defaultProvider: string = JUDGE_DEFAULT_PROVIDER,
): JudgeProviderDiagnostic[] {
  return checkJudge(source, JUDGE_BUILTIN_PROVIDERS, defaultProvider, "warning");
}

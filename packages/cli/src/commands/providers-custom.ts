// `swarm providers add --custom` and per-model ops (ls-models /
// add-model / rm-model / edit-model) — read and write the global
// swarm store's `provider_config` table.
//
// A "custom provider" means an OpenAI-completions-compatible endpoint
// (Ollama, vLLM, LM Studio, a corporate proxy, etc.) that is NOT built
// into pi-ai. The user supplies:
//   - provider name (slug, e.g. "ollama")
//   - base URL (e.g. "http://localhost:11434/v1")
//   - one or more model IDs (e.g. "llama3.1:8b")
//   - API shape (openai_completions | openai_responses)
//
// Credentials are NOT prompted here — a custom provider that needs
// auth uses the normal `swarm providers add <name>` flow into the
// `provider_credentials` table. Keyless providers (Ollama) need no
// credential row at all.
//
// Per-model ops (docs/proposals/provider-model-ops.md) target a row
// that already exists. Each verb loads the parsed `ProviderEntry`,
// mutates `models[]`, Ajv-validates the whole blob, and upserts.

import { ProviderConfigSchema } from "@swarm/agent";
import type { IProviderConfigStore } from "@swarm/store";
import type { ValidateFunction } from "ajv";
import AjvModule from "ajv";
import chalk from "chalk";
import prompts from "prompts";
import { openGlobalStore } from "./open-global-store.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-provider definition body. Mirrors the agent layer's
 * `ProviderConfigSchema` shape minus `apiKey` (which lives in
 * `provider_credentials`). */
export interface ProviderEntry {
  baseUrl: string;
  api?: string;
  compat?: Record<string, unknown>;
  models: ModelEntry[];
}

/** One model entry inside a provider's `models[]`. Carries the full
 * 8-field shape pi-ai's `Model<Api>` requires so per-model writes
 * persist a complete row. */
export interface ModelEntry {
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Flag bag for `swarm providers add-model` / `edit-model`. All
 * fields optional — undefined means "use heuristic default" (add)
 * or "preserve existing value" (edit). */
export interface ModelOpsFlags {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  costInput?: number;
  costOutput?: number;
  yes?: boolean;
}

export type AddModelFlags = ModelOpsFlags;
export type EditModelFlags = ModelOpsFlags;

// ---------------------------------------------------------------------------
// Input validation helpers (pure)
// ---------------------------------------------------------------------------

/** Validate a provider name slug. Returns an error string or `true`. */
export function validateProviderName(value: string): true | string {
  if (!value || value.trim().length === 0) return "provider name must not be empty";
  if (!/^[a-z0-9_-]+$/i.test(value)) return "provider name must be alphanumeric (hyphens/underscores allowed)";
  return true;
}

/** Validate a base URL. Returns an error string or `true`. */
export function validateBaseUrl(value: string): true | string {
  if (!value || value.trim().length === 0) return "base URL must not be empty";
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "base URL must use http or https";
    }
    return true;
  } catch {
    return "base URL is not a valid URL (e.g. http://localhost:11434/v1)";
  }
}

/** Validate a model ID. Returns an error string or `true`. */
export function validateModelId(value: string): true | string {
  if (!value || value.trim().length === 0) return "model ID must not be empty";
  return true;
}

// ---------------------------------------------------------------------------
// Default model-id → context-window / max-tokens heuristics
// ---------------------------------------------------------------------------

/** Infer sensible contextWindow / maxTokens defaults from a model id. */
export function inferModelDefaults(modelId: string): { contextWindow: number; maxTokens: number } {
  const id = modelId.toLowerCase();
  if (id.includes("llama3") || id.includes("llama-3")) return { contextWindow: 128_000, maxTokens: 8_192 };
  if (id.includes("llama2") || id.includes("llama-2")) return { contextWindow: 4_096, maxTokens: 2_048 };
  if (id.includes("mistral") || id.includes("mixtral")) return { contextWindow: 32_768, maxTokens: 8_192 };
  if (id.includes("gemma")) return { contextWindow: 8_192, maxTokens: 4_096 };
  if (id.includes("phi")) return { contextWindow: 16_384, maxTokens: 4_096 };
  if (id.includes("qwen")) return { contextWindow: 32_768, maxTokens: 8_192 };
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

// ---------------------------------------------------------------------------
// API type selection
// ---------------------------------------------------------------------------

/** The two OpenAI-compat API shapes pi-ai supports for custom providers.
 * "openai_completions" covers Ollama / vLLM / LM Studio.
 * "openai_responses" covers providers that use the newer Responses API. */
export const SUPPORTED_APIS = ["openai_completions", "openai_responses"] as const;
export type SupportedApi = (typeof SUPPORTED_APIS)[number];

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

/** Build a complete `ModelEntry` from an id and optional overrides.
 * Pure. The override bag wins over `inferModelDefaults(id)` heuristics
 * and the field-zero defaults; `id` is re-pinned last so callers
 * cannot rename via the bag. */
export function buildModelEntry(
  args: { id: string; api?: string } & Partial<Omit<ModelEntry, "id" | "api" | "cost">> & {
      cost?: Partial<ModelCost>;
    },
): ModelEntry {
  const { id } = args;
  const heuristic = inferModelDefaults(id);
  const cost: ModelCost = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...(args.cost ?? {}),
  };
  return {
    id,
    name: args.name ?? id,
    api: args.api ?? "openai_completions",
    contextWindow: args.contextWindow ?? heuristic.contextWindow,
    maxTokens: args.maxTokens ?? heuristic.maxTokens,
    reasoning: args.reasoning ?? false,
    input: args.input ?? ["text"],
    cost,
  };
}

export interface CustomProviderAnswers {
  providerName: string;
  baseUrl: string;
  api: SupportedApi;
  modelIds: string[];
}

/** Build a ProviderEntry from wizard answers. Pure — no I/O. The
 * resulting object is the JSON body persisted under
 * `provider_config.config`; no `apiKey` field (credentials live in
 * `provider_credentials`). */
export function buildProviderEntry(answers: CustomProviderAnswers): ProviderEntry {
  const models: ModelEntry[] = answers.modelIds.map((id) => buildModelEntry({ id: id.trim(), api: answers.api }));
  return {
    baseUrl: answers.baseUrl,
    api: answers.api,
    models,
  };
}

/** Merge a new ProviderEntry into an existing one. Pure. */
export function mergeProviderEntry(existing: ProviderEntry, next: ProviderEntry, overwrite: boolean): ProviderEntry {
  if (overwrite) return next;
  const modelMap = new Map<string, ModelEntry>();
  for (const m of existing.models) modelMap.set(m.id, m);
  for (const m of next.models) modelMap.set(m.id, m);
  return {
    ...existing,
    baseUrl: next.baseUrl,
    ...(next.api !== undefined ? { api: next.api } : {}),
    ...(next.compat !== undefined ? { compat: next.compat } : {}),
    models: [...modelMap.values()],
  };
}

// ---------------------------------------------------------------------------
// Ajv validation (defence in depth on writes)
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: Ajv's default export is runtime-dependent.
const Ajv = (AjvModule as any).default || AjvModule;
let cachedValidator: ValidateFunction | null = null;

function getValidator(): ValidateFunction {
  if (cachedValidator !== null) return cachedValidator;
  const ajv = new Ajv();
  cachedValidator = ajv.compile(ProviderConfigSchema) as ValidateFunction;
  return cachedValidator;
}

/** Ajv-validate a `ProviderEntry` against the agent layer's
 * `ProviderConfigSchema`. Defence in depth: `ModelRegistry.loadCustomModels`
 * also validates on read, but catching typos before write produces a
 * better error message at the spot the operator caused them. */
export function validateProviderEntryWrite(entry: ProviderEntry): { ok: true } | { ok: false; errors: string } {
  const validate = getValidator();
  const ok = validate(entry);
  if (ok) return { ok: true };
  const ajv = new Ajv();
  const errors = ajv.errorsText(validate.errors ?? []);
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Provider lookup helper (shared by the four per-model verbs)
// ---------------------------------------------------------------------------

/** Look up a parsed `ProviderEntry` by provider id. Prints the
 *  canonical "not found" message + returns `null` on miss so callers
 *  can short-circuit to exit code 1. Also runs Ajv against the
 *  loaded blob — a structurally-broken row is refused before any
 *  mutation, with the same `schema validation failed` message a
 *  bad write would produce. */
export function loadProviderEntry(store: IProviderConfigStore, provider: string): ProviderEntry | null {
  const row = store.getProviderConfig(provider);
  if (row == null) {
    console.error(chalk.red(`provider "${provider}" not found in provider_config`));
    console.error(chalk.dim("  run `swarm providers ls` to see what's installed"));
    return null;
  }
  const entry = row.config as ProviderEntry;
  const validation = validateProviderEntryWrite(entry);
  if (!validation.ok) {
    console.error(chalk.red(`schema validation failed: ${validation.errors}`));
    return null;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Per-model ops: ls-models / add-model / rm-model / edit-model
// ---------------------------------------------------------------------------

function formatModelRow(m: ModelEntry): string {
  const id = m.id.padEnd(28);
  const name = (m.name ?? m.id).padEnd(28);
  const ctx = String(m.contextWindow).padStart(8);
  const max = String(m.maxTokens).padStart(7);
  const reasoning = (m.reasoning ? "yes" : "no").padEnd(4);
  const ci = m.cost.input.toFixed(2).padStart(7);
  const co = m.cost.output.toFixed(2).padStart(7);
  return `${id}${chalk.dim(name)}${ctx} ${max}  ${reasoning} ${ci} ${co}`;
}

export async function providersLsModelsCommand(provider: string): Promise<number> {
  const store = openGlobalStore();
  try {
    const entry = loadProviderEntry(store, provider);
    if (entry == null) return 1;
    const sorted = [...entry.models].sort((a, b) => a.id.localeCompare(b.id));
    console.log(chalk.bold(`Models under "${provider}":\n`));
    const header = `${"id".padEnd(28)}${"name".padEnd(28)}${"ctx".padStart(8)} ${"max".padStart(7)}  ${"rsn".padEnd(4)} ${"in$".padStart(7)} ${"out$".padStart(7)}`;
    console.log(chalk.dim(header));
    for (const m of sorted) console.log(formatModelRow(m));
    console.log(chalk.dim(`\n${sorted.length} model${sorted.length === 1 ? "" : "s"}`));
    return 0;
  } finally {
    store.close();
  }
}

/** Partial override shape used by add-model/edit-model. `cost` is a
 * field-wise partial that merges onto the existing model's cost. */
type ModelOverrideBag = Omit<Partial<ModelEntry>, "cost"> & { cost?: Partial<ModelCost> };

/** Turn a flag bag into a `ModelOverrideBag`. Drops undefined entries
 *  — `edit-model` must not clobber preserved fields with `undefined`. */
function flagsToOverrides(flags: ModelOpsFlags): ModelOverrideBag {
  const out: ModelOverrideBag = {};
  if (flags.name !== undefined) out.name = flags.name;
  if (flags.contextWindow !== undefined) out.contextWindow = flags.contextWindow;
  if (flags.maxTokens !== undefined) out.maxTokens = flags.maxTokens;
  if (flags.reasoning !== undefined) out.reasoning = flags.reasoning;
  if (flags.input !== undefined) out.input = flags.input;
  if (flags.costInput !== undefined || flags.costOutput !== undefined) {
    const cost: Partial<ModelCost> = {};
    if (flags.costInput !== undefined) cost.input = flags.costInput;
    if (flags.costOutput !== undefined) cost.output = flags.costOutput;
    out.cost = cost;
  }
  return out;
}

/** Apply an override bag onto an existing `ModelEntry`, preserving
 *  every unmentioned field byte-identically. `cost` merges field-wise. */
function applyOverrides(existing: ModelEntry, overrides: ModelOverrideBag): ModelEntry {
  const { cost: costOverride, ...rest } = overrides;
  const merged: ModelEntry = { ...existing, ...rest };
  if (costOverride !== undefined) {
    merged.cost = { ...existing.cost, ...costOverride };
  }
  return merged;
}

export async function providersAddModelCommand(
  provider: string,
  modelId: string,
  flags: AddModelFlags = {},
): Promise<number> {
  const store = openGlobalStore();
  try {
    const entry = loadProviderEntry(store, provider);
    if (entry == null) return 1;
    if (entry.models.some((m) => m.id === modelId)) {
      console.error(
        chalk.red(`model "${modelId}" already exists in "${provider}" — use \`swarm providers edit-model\` instead`),
      );
      return 1;
    }
    const overrides = flagsToOverrides(flags);
    const next = buildModelEntry({ id: modelId, api: entry.api ?? "openai_completions", ...overrides });

    if (!flags.yes) {
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: `Add model "${modelId}" to "${provider}" (ctx=${next.contextWindow}, max=${next.maxTokens})?`,
        initial: true,
      });
      if (!confirm) {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
    }

    const updated: ProviderEntry = { ...entry, models: [...entry.models, next] };
    const validation = validateProviderEntryWrite(updated);
    if (!validation.ok) {
      console.error(chalk.red(`schema validation failed: ${validation.errors}`));
      return 1;
    }
    try {
      store.upsertProviderConfig({ provider, config: JSON.stringify(updated) });
    } catch (err) {
      console.error(chalk.red(`failed to write provider_config: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
    console.log(chalk.green(`✓ added model "${modelId}" to "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}

export async function providersRmModelCommand(
  provider: string,
  modelId: string,
  flags: { yes?: boolean } = {},
): Promise<number> {
  const store = openGlobalStore();
  try {
    const entry = loadProviderEntry(store, provider);
    if (entry == null) return 1;
    if (!entry.models.some((m) => m.id === modelId)) {
      console.error(
        chalk.red(`model "${modelId}" not found in "${provider}" — run \`swarm providers ls-models ${provider}\``),
      );
      return 1;
    }

    if (!flags.yes) {
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: `Remove model "${modelId}" from "${provider}"?`,
        initial: false,
      });
      if (!confirm) {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
    }

    const updated: ProviderEntry = { ...entry, models: entry.models.filter((m) => m.id !== modelId) };
    const validation = validateProviderEntryWrite(updated);
    if (!validation.ok) {
      console.error(chalk.red(`schema validation failed: ${validation.errors}`));
      return 1;
    }
    try {
      store.upsertProviderConfig({ provider, config: JSON.stringify(updated) });
    } catch (err) {
      console.error(chalk.red(`failed to write provider_config: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
    console.log(chalk.green(`✓ removed model "${modelId}" from "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}

export async function providersEditModelCommand(
  provider: string,
  modelId: string,
  flags: EditModelFlags = {},
): Promise<number> {
  const store = openGlobalStore();
  try {
    const entry = loadProviderEntry(store, provider);
    if (entry == null) return 1;
    const idx = entry.models.findIndex((m) => m.id === modelId);
    if (idx < 0) {
      console.error(
        chalk.red(`model "${modelId}" not found in "${provider}" — use \`swarm providers add-model\` instead`),
      );
      return 1;
    }
    const existing = entry.models[idx]!;
    const overrides = flagsToOverrides(flags);
    if (Object.keys(overrides).length === 0) {
      console.error(chalk.red("edit-model: no flag-supplied fields — pass at least one of"));
      console.error(chalk.dim("  --name --context-window --max-tokens --reasoning --input --cost-input --cost-output"));
      return 1;
    }
    const updatedModel = applyOverrides(existing, overrides);
    if (!flags.yes) {
      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: `Update model "${modelId}" on "${provider}"?`,
        initial: true,
      });
      if (!confirm) {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
    }
    const nextModels = [...entry.models];
    nextModels[idx] = updatedModel;
    const updated: ProviderEntry = { ...entry, models: nextModels };
    const validation = validateProviderEntryWrite(updated);
    if (!validation.ok) {
      console.error(chalk.red(`schema validation failed: ${validation.errors}`));
      return 1;
    }
    try {
      store.upsertProviderConfig({ provider, config: JSON.stringify(updated) });
    } catch (err) {
      console.error(chalk.red(`failed to write provider_config: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }
    console.log(chalk.green(`✓ updated model "${modelId}" on "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Main wizard (swarm providers add --custom)
// ---------------------------------------------------------------------------

export async function providersAddCustomCommand(): Promise<number> {
  console.log(chalk.bold("Add a custom (OpenAI-compatible) provider\n"));

  // ── Step 1: provider name ──
  const { providerName } = await prompts({
    type: "text",
    name: "providerName",
    message: "Provider name (slug, e.g. ollama, my-proxy)",
    validate: (v: string) => validateProviderName(v),
  });
  if (!providerName) {
    console.log(chalk.dim("cancelled"));
    return 0;
  }

  const store = openGlobalStore();
  try {
    // ── Step 2: existing provider conflict? ──
    let overwrite = false;
    let existingEntry: ProviderEntry | null = null;
    const existingRow = store.getProviderConfig(providerName as string);
    if (existingRow != null) {
      existingEntry = existingRow.config as ProviderEntry;
      const { choice } = await prompts({
        type: "select",
        name: "choice",
        message: `"${providerName}" already exists in provider_config — what should swarm do?`,
        choices: [
          { title: "Merge — keep existing models, add/update the ones I specify", value: "merge" },
          { title: "Overwrite — replace the entire provider entry", value: "overwrite" },
          { title: "Cancel", value: "cancel" },
        ],
      });
      if (!choice || choice === "cancel") {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
      overwrite = choice === "overwrite";
    }

    // ── Step 3: base URL ──
    const { baseUrl } = await prompts({
      type: "text",
      name: "baseUrl",
      message: "Base URL (e.g. http://localhost:11434/v1)",
      validate: (v: string) => validateBaseUrl(v),
    });
    if (!baseUrl) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }

    // ── Step 4: API shape ──
    const { api } = await prompts({
      type: "select",
      name: "api",
      message: "API shape",
      choices: [
        {
          title: "openai_completions — Ollama, vLLM, LM Studio, most local servers",
          value: "openai_completions",
        },
        {
          title: "openai_responses — OpenAI Responses API (newer endpoints)",
          value: "openai_responses",
        },
      ],
    });
    if (!api) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }

    // ── Step 5: model IDs ──
    const { firstModel } = await prompts({
      type: "text",
      name: "firstModel",
      message: "First model ID (e.g. llama3.1:8b, gpt-4o-mini)",
      validate: (v: string) => validateModelId(v),
    });
    if (!firstModel) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }

    const modelIds: string[] = [firstModel as string];
    while (true) {
      const { more } = await prompts({
        type: "confirm",
        name: "more",
        message: "Add another model?",
        initial: false,
      });
      if (!more) break;
      const { modelId } = await prompts({
        type: "text",
        name: "modelId",
        message: "Model ID",
        validate: (v: string) => validateModelId(v),
      });
      if (!modelId) break;
      modelIds.push(modelId as string);
    }

    // ── Build + write ──
    const answers: CustomProviderAnswers = {
      providerName: providerName as string,
      baseUrl: baseUrl as string,
      api: api as SupportedApi,
      modelIds,
    };

    const fresh = buildProviderEntry(answers);
    const merged = existingEntry != null ? mergeProviderEntry(existingEntry, fresh, overwrite) : fresh;

    try {
      store.upsertProviderConfig({
        provider: providerName as string,
        config: JSON.stringify(merged),
      });
    } catch (err) {
      console.error(chalk.red(`Failed to write provider_config: ${err instanceof Error ? err.message : String(err)}`));
      return 1;
    }

    console.log();
    console.log(chalk.green(`✓ added provider "${providerName}" to provider_config`));
    console.log(chalk.dim(`  models:   ${modelIds.join(", ")}`));
    console.log(chalk.dim(`  base URL: ${baseUrl}`));
    console.log();
    console.log(
      chalk.dim(`If this provider needs auth, run \`swarm providers add ${providerName}\` to store a credential.`),
    );
    console.log(chalk.dim(`Use \`swarm providers test ${providerName} ${modelIds[0]}\` to verify the connection.`));

    return 0;
  } finally {
    store.close();
  }
}

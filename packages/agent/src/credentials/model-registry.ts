// Model registry — manages built-in and custom models and resolves
// per-request auth + headers via AuthStorage.
//
// Built-in models come from pi-ai's registry (getProviders + getModels).
// The `provider_config` table on the global swarm store (one row per
// provider id) lets the user:
//   - add custom providers (Ollama, vLLM, LM Studio, proxies)
//   - override a built-in provider's baseUrl / compat (route through a
//     proxy without redefining every model)
//   - override specific built-in models (fix stale cost, pin routing)
//   - add custom models under a built-in provider
//
// Per-row Ajv validation lives in `loadCustomModels`: one corrupt row
// is skipped (surfaced via `getError()`) without poisoning the rest
// of the registry.
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/model-registry.ts) — MIT. Upstream in
// @mariozechner/pi-mono. Revisit if the pi project splits this out.
//
// Swarm-specific deltas:
// - Custom-provider definitions live in `provider_config` rows, not
//   on disk. `ModelRegistry.create(authStorage, store)` reads them at
//   construction; `refresh()` re-reads.
// - The `apiKey` field is gone from `ProviderConfigSchema` /
//   `ProviderConfigInput`. Credentials always come from
//   `provider_credentials` via `AuthStorage`.
// - `!cmd` / env-var resolution is gone repo-wide — keys and headers
//   are stored verbatim.
// - Extension registration (custom streamSimple + OAuth provider) is
//   preserved since summariser / custom-provider flows may need it.

import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  type OAuthProviderInterface,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  registerApiProvider,
  resetApiProviders,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import { registerOAuthProvider, resetOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { type Static, Type } from "@sinclair/typebox";
import type { IProviderConfigStore } from "@swarm/store";
import AjvModule from "ajv";
import type { AuthStorage } from "./auth-storage.ts";

// biome-ignore lint/suspicious/noExplicitAny: Ajv's default export is runtime-dependent.
const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv();

// ---------------------------------------------------------------------------
// Schemas (TypeBox → Ajv)
// ---------------------------------------------------------------------------

const PercentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  require_parameters: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
  zdr: Type.Optional(Type.Boolean()),
  enforce_distillable_text: Type.Optional(Type.Boolean()),
  order: Type.Optional(Type.Array(Type.String())),
  only: Type.Optional(Type.Array(Type.String())),
  ignore: Type.Optional(Type.Array(Type.String())),
  quantizations: Type.Optional(Type.Array(Type.String())),
  sort: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        by: Type.Optional(Type.String()),
        partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ]),
  ),
  max_price: Type.Optional(
    Type.Object({
      prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    }),
  ),
  preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
  preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
});

const ReasoningEffortMapSchema = Type.Object({
  minimal: Type.Optional(Type.String()),
  low: Type.Optional(Type.String()),
  medium: Type.Optional(Type.String()),
  high: Type.Optional(Type.String()),
  xhigh: Type.Optional(Type.String()),
});

const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("qwen-chat-template"),
    ]),
  ),
  cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
  supportsStrictMode: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({});

const OpenAICompatSchema = Type.Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema]);

const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
    }),
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
});

const ModelOverrideSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number()),
    }),
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(OpenAICompatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
  modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

const ModelsConfigSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});

ajv.addSchema(ModelsConfigSchema, "ModelsConfig");
// Per-row validation surface for `provider_config` writers (CLI). The
// schema mirrors the per-provider body — minus `apiKey`, which lives
// in `provider_credentials`.
export { ProviderConfigSchema };

type ModelsConfig = Static<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProviderOverride {
  baseUrl: string | undefined;
  compat: Model<Api>["compat"] | undefined;
}

interface ProviderRequestConfig {
  headers: Record<string, string> | undefined;
  authHeader: boolean | undefined;
}

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error: string };

interface CustomModelsResult {
  models: Model<Api>[];
  overrides: Map<string, ProviderOverride>;
  modelOverrides: Map<string, Map<string, ModelOverride>>;
  error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
  baseCompat: Model<Api>["compat"],
  overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
  if (!overrideCompat) return baseCompat;
  const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;
  const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat;
  const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat;
  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;
  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting,
    };
  }
  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting,
    };
  }
  return merged as Model<Api>["compat"];
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
  const result = { ...model };
  if (override.name !== undefined) result.name = override.name;
  if (override.reasoning !== undefined) result.reasoning = override.reasoning;
  if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
  if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;
  if (override.cost) {
    result.cost = {
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
    };
  }
  const mergedCompat = mergeCompat(model.compat, override.compat);
  if (mergedCompat !== undefined) result.compat = mergedCompat;
  else delete (result as { compat?: unknown }).compat;
  return result;
}

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private models: Model<Api>[] = [];
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;
  /** Revision watermark captured at the end of `loadModels`. Compared
   * against the store's current `getProviderConfigRevision()` at the
   * start of every public read to detect out-of-process mutations
   * (CLI `swarm providers add --custom` while the daemon runs). */
  private lastConfigRevision: { maxUpdatedAt: number; rowCount: number } = {
    maxUpdatedAt: 0,
    rowCount: 0,
  };

  private constructor(
    readonly authStorage: AuthStorage,
    private store: IProviderConfigStore | undefined,
  ) {
    this.loadModels();
  }

  /** Reload `loadModels` if another process has mutated `provider_config`
   * since our last load. Cheap aggregate query against a small table —
   * one short read per call, no rebuild when the revision matches. */
  private ensureFresh(): void {
    if (!this.store) return;
    const rev = this.store.getProviderConfigRevision();
    if (
      rev.maxUpdatedAt !== this.lastConfigRevision.maxUpdatedAt ||
      rev.rowCount !== this.lastConfigRevision.rowCount
    ) {
      this.loadModels();
    }
  }

  /** Store-backed. Reads custom-provider definitions from the global
   * store's `provider_config` table. */
  static create(authStorage: AuthStorage, store: IProviderConfigStore): ModelRegistry {
    return new ModelRegistry(authStorage, store);
  }

  /** No store backing — tests that don't exercise the custom-provider
   * path. Built-in pi-ai models still load. */
  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /** Re-read provider_config rows + re-apply any dynamically-registered
   * providers. */
  refresh(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;
    resetApiProviders();
    resetOAuthProviders();
    this.loadModels();
    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  getError(): string | undefined {
    return this.loadError;
  }

  private loadModels(): void {
    // Snapshot the revision BEFORE the load so a concurrent write that
    // lands while we're rebuilding triggers a re-load on the next read
    // (rather than getting swallowed by a post-load watermark that's
    // newer than what we actually captured).
    const revBefore = this.store?.getProviderConfigRevision() ?? { maxUpdatedAt: 0, rowCount: 0 };
    const {
      models: customModels,
      overrides,
      modelOverrides,
      error,
    } = this.store ? this.loadCustomModels(this.store) : emptyCustomModelsResult();
    if (error) this.loadError = error;
    const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
    let combined = this.mergeCustomModels(builtInModels, customModels);
    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }
    this.models = combined;
    this.lastConfigRevision = revBefore;
  }

  private loadBuiltInModels(
    overrides: Map<string, ProviderOverride>,
    modelOverrides: Map<string, Map<string, ModelOverride>>,
  ): Model<Api>[] {
    return getProviders().flatMap((provider) => {
      const models = getModels(provider as KnownProvider) as Model<Api>[];
      const providerOverride = overrides.get(provider);
      const perModelOverrides = modelOverrides.get(provider);
      return models.map((m) => {
        let model = m;
        if (providerOverride) {
          const mergedCompat = mergeCompat(model.compat, providerOverride.compat);
          const next: Model<Api> = {
            ...model,
            baseUrl: providerOverride.baseUrl ?? model.baseUrl,
          };
          if (mergedCompat !== undefined) next.compat = mergedCompat;
          else delete (next as { compat?: unknown }).compat;
          model = next;
        }
        const modelOverride = perModelOverrides?.get(m.id);
        if (modelOverride) model = applyModelOverride(model, modelOverride);
        return model;
      });
    });
  }

  private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
      const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
      if (existingIndex >= 0) merged[existingIndex] = customModel;
      else merged.push(customModel);
    }
    return merged;
  }

  private loadCustomModels(store: IProviderConfigStore): CustomModelsResult {
    const overrides = new Map<string, ProviderOverride>();
    const modelOverrides = new Map<string, Map<string, ModelOverride>>();
    const acceptedProviders: Record<string, Static<typeof ProviderConfigSchema>> = {};
    const errors: string[] = [];
    const validate = ajv.getSchema("ModelsConfig")!;

    let rows: Array<{ provider: string; config: unknown }>;
    try {
      rows = store.listProviderConfigs();
    } catch (error) {
      return emptyCustomModelsResult(
        `Failed to read provider_config: ${error instanceof Error ? error.message : error}`,
      );
    }

    for (const row of rows) {
      // Per-row Ajv validation. Wrap the row in the whole-file shape so
      // the existing compiled schema applies; a corrupt row is logged
      // and skipped, sibling rows still load.
      const wrapped = { providers: { [row.provider]: row.config } };
      if (!validate(wrapped)) {
        const details =
          // biome-ignore lint/suspicious/noExplicitAny: Ajv error shape is loose.
          validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
          "Unknown schema error";
        errors.push(`provider_config[${row.provider}]: invalid schema\n${details}`);
        continue;
      }
      const providerConfig = (wrapped as ModelsConfig).providers[row.provider]!;
      try {
        this.validateConfig({ providers: { [row.provider]: providerConfig } });
      } catch (err) {
        errors.push(`provider_config[${row.provider}]: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      acceptedProviders[row.provider] = providerConfig;
      if (providerConfig.baseUrl || providerConfig.compat) {
        overrides.set(row.provider, {
          baseUrl: providerConfig.baseUrl ?? undefined,
          compat: providerConfig.compat ?? undefined,
        });
      }
      this.storeProviderRequestConfig(row.provider, providerConfig);
      if (providerConfig.modelOverrides) {
        modelOverrides.set(row.provider, new Map(Object.entries(providerConfig.modelOverrides)));
        for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
          this.storeModelHeaders(row.provider, modelId, modelOverride.headers);
        }
      }
    }

    const error = errors.length === 0 ? undefined : errors.join("\n\n");
    const combined: ModelsConfig = { providers: acceptedProviders };
    return { models: this.parseModels(combined), overrides, modelOverrides, error };
  }

  private validateConfig(config: ModelsConfig): void {
    const builtInProviders = new Set<string>(getProviders());
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const isBuiltIn = builtInProviders.has(providerName);
      const hasProviderApi = !!providerConfig.api;
      const models = providerConfig.models ?? [];
      const hasModelOverrides = providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;
      if (models.length === 0) {
        if (!providerConfig.baseUrl && !providerConfig.compat && !hasModelOverrides) {
          throw new Error(`Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", or "models".`);
        }
      } else if (!isBuiltIn) {
        if (!providerConfig.baseUrl) {
          throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
        }
        // Credentials live in `provider_credentials`, not on this
        // config blob — keyless custom providers (Ollama) are valid;
        // `hasAuth(name)` returns false and `getAvailable()` filters
        // them out at request time.
      }
      for (const modelDef of models) {
        const hasModelApi = !!modelDef.api;
        if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
          );
        }
        if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
      }
    }
  }

  private parseModels(config: ModelsConfig): Model<Api>[] {
    const models: Model<Api>[] = [];
    const builtInProviders = new Set<string>(getProviders());
    const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
    const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
      if (!builtInProviders.has(providerName)) return undefined;
      if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
      const builtIn = getModels(providerName as KnownProvider) as Model<Api>[];
      const first = builtIn[0];
      if (!first) return undefined;
      const defaults = { api: first.api, baseUrl: first.baseUrl };
      builtInDefaultsCache.set(providerName, defaults);
      return defaults;
    };
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) continue;
      const builtInDefaults = getBuiltInDefaults(providerName);
      for (const modelDef of modelDefs) {
        const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
        if (!api) continue;
        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
        if (!baseUrl) continue;
        const compat = mergeCompat(providerConfig.compat, modelDef.compat);
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
        const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const next: Model<Api> = {
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
          cost: modelDef.cost ?? defaultCost,
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
        };
        if (compat !== undefined) next.compat = compat;
        models.push(next);
      }
    }
    return models;
  }

  /** Every model — built-in + custom, post-override. */
  getAll(): Model<Api>[] {
    this.ensureFresh();
    return this.models;
  }

  /** Models whose provider has *some* form of auth configured. Fast;
   * does not refresh OAuth. */
  getAvailable(): Model<Api>[] {
    this.ensureFresh();
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  /** Find by `(provider, id)`. Exact match only. */
  find(provider: string, modelId: string): Model<Api> | undefined {
    this.ensureFresh();
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return this.authStorage.hasAuth(model.provider);
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: { headers?: Record<string, string>; authHeader?: boolean },
  ): void {
    if (!config.headers && !config.authHeader) return;
    this.providerRequestConfigs.set(providerName, {
      headers: config.headers ?? undefined,
      authHeader: config.authHeader ?? undefined,
    });
  }

  private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  /** Resolve API key + request headers for a specific model. Keys come
   * from `provider_credentials` via `AuthStorage`; headers are stored
   * verbatim on the `provider_config` blob (no `!cmd` / env-var
   * resolution). */
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    this.ensureFresh();
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const apiKey = await this.authStorage.getApiKey(model.provider);
      const providerHeaders = providerConfig?.headers;
      const modelHeaders = this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id));
      let headers: Record<string, string> | undefined =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;
      if (providerConfig?.authHeader) {
        if (!apiKey) return { ok: false, error: `No API key found for "${model.provider}"` };
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }
      const out: ResolvedRequestAuth = { ok: true };
      if (apiKey !== undefined) out.apiKey = apiKey;
      if (headers && Object.keys(headers).length > 0) out.headers = headers;
      return out;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.authStorage.getApiKey(provider);
  }

  isUsingOAuth(model: Model<Api>): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /** Programmatic provider registration. If `models` is supplied it
   * replaces the provider's model list; otherwise `baseUrl`/`headers`
   * just override existing models. `streamSimple` + `api` registers a
   * custom API shape with pi-ai. */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.registeredProviders.set(providerName, config);
  }

  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) return;
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }
    if (!config.models || config.models.length === 0) return;
    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    // Credentials live in `provider_credentials` (api_key) or via the
    // OAuth provider hook — not on this registration input.
    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.oauth) {
      const oauthProvider: OAuthProviderInterface = { ...config.oauth, id: providerName };
      registerOAuthProvider(oauthProvider);
    }
    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }
    this.storeProviderRequestConfig(providerName, config);
    if (config.models && config.models.length > 0) {
      this.models = this.models.filter((m) => m.provider !== providerName);
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
        const next: Model<Api> = {
          id: modelDef.id,
          name: modelDef.name,
          api: api as Api,
          provider: providerName,
          baseUrl: config.baseUrl!,
          reasoning: modelDef.reasoning,
          input: modelDef.input as ("text" | "image")[],
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
        };
        if (modelDef.compat !== undefined) next.compat = modelDef.compat;
        this.models.push(next);
      }
      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    } else if (config.baseUrl || config.headers) {
      this.models = this.models.map((m) => {
        if (m.provider !== providerName) return m;
        return { ...m, baseUrl: config.baseUrl ?? m.baseUrl };
      });
    }
  }
}

/** Programmatic registration input. Used by extensions / tests that
 * want to add a provider without writing a `provider_config` row.
 * Credentials always come from `provider_credentials` via
 * `AuthStorage`; no `apiKey` field on this shape. */
export interface ProviderConfigInput {
  baseUrl?: string;
  api?: Api;
  streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  headers?: Record<string, string>;
  authHeader?: boolean;
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
  }>;
}

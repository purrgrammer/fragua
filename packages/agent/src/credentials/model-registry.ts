// Model registry — manages built-in and custom models and resolves
// per-request auth + headers via AuthStorage.
//
// Built-in models come from pi-ai's registry (getProviders + getModels).
// ~/.swarm/models.json lets the user:
//   - add custom providers (Ollama, vLLM, LM Studio, proxies)
//   - override a built-in provider's baseUrl / compat (route through a
//     proxy without redefining every model)
//   - override specific built-in models (fix stale cost, pin routing)
//   - add custom models under a built-in provider
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/model-registry.ts) — MIT. Upstream in
// @mariozechner/pi-mono. Revisit if the pi project splits this out.
//
// Swarm-specific deltas:
// - `getAgentDir()` → swarm's `resolveModelsPath()`.
// - Constructor auto-wires `AuthStorage.setFallbackResolver` so custom
//   providers declared in models.json surface through every AuthStorage
//   touchpoint (`hasAuth`, `describeAuthSource`, `getApiKey`). Pi's
//   call sites all go through `getApiKeyAndHeaders` which already
//   reads the registry directly; swarm's daemon threads a bare
//   `getApiKey(provider)` callback into the agent backend, so without
//   the wire a models.json-only provider looks uncredentialed end-
//   to-end.
// - Otherwise a near-verbatim port; extension registration (custom
//   streamSimple + OAuth provider) preserved since summariser /
//   custom-provider flows may need it.

import { existsSync, readFileSync } from "node:fs";
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
import AjvModule from "ajv";
import type { AuthStorage } from "./auth-storage.ts";
import { resolveModelsPath } from "./paths.ts";
import {
  clearConfigValueCache,
  resolveConfigValue,
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

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
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
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

type ModelsConfig = Static<typeof ModelsConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ProviderOverride {
  baseUrl: string | undefined;
  compat: Model<Api>["compat"] | undefined;
}

interface ProviderRequestConfig {
  apiKey: string | undefined;
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

/** Re-exported so callers can drop the `!cmd` cache without importing
 * from resolve-config-value directly. */
export const clearApiKeyCache = clearConfigValueCache;

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  private models: Model<Api>[] = [];
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;

  private constructor(
    readonly authStorage: AuthStorage,
    private modelsJsonPath: string | undefined,
  ) {
    this.loadModels();
    authStorage.setFallbackResolver((provider) => this.resolveCustomProviderApiKey(provider));
  }

  private resolveCustomProviderApiKey(provider: string): string | undefined {
    const cfg = this.providerRequestConfigs.get(provider);
    if (!cfg?.apiKey) return undefined;
    return resolveConfigValue(cfg.apiKey);
  }

  /** File-backed. Reads ~/.swarm/models.json (with pi fallback). */
  static create(authStorage: AuthStorage, modelsJsonPath: string = resolveModelsPath()): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath);
  }

  /** No file backing — tests. */
  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /** Re-read models.json + re-apply any dynamically-registered providers. */
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
    const {
      models: customModels,
      overrides,
      modelOverrides,
      error,
    } = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();
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

  private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
    if (!existsSync(modelsJsonPath)) return emptyCustomModelsResult();
    try {
      const content = readFileSync(modelsJsonPath, "utf-8");
      const config: ModelsConfig = JSON.parse(content);
      const validate = ajv.getSchema("ModelsConfig")!;
      if (!validate(config)) {
        const errors =
          // biome-ignore lint/suspicious/noExplicitAny: Ajv error shape is loose.
          validate.errors?.map((e: any) => `  - ${e.instancePath || "root"}: ${e.message}`).join("\n") ||
          "Unknown schema error";
        return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
      }
      this.validateConfig(config);
      const overrides = new Map<string, ProviderOverride>();
      const modelOverrides = new Map<string, Map<string, ModelOverride>>();
      for (const [providerName, providerConfig] of Object.entries(config.providers)) {
        if (providerConfig.baseUrl || providerConfig.compat) {
          overrides.set(providerName, {
            baseUrl: providerConfig.baseUrl ?? undefined,
            compat: providerConfig.compat ?? undefined,
          });
        }
        this.storeProviderRequestConfig(providerName, providerConfig);
        if (providerConfig.modelOverrides) {
          modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
          for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
            this.storeModelHeaders(providerName, modelId, modelOverride.headers);
          }
        }
      }
      return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
      );
    }
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
        if (!providerConfig.apiKey) {
          throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
        }
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
    return this.models;
  }

  /** Models whose provider has *some* form of auth configured. Fast;
   * does not refresh OAuth. */
  getAvailable(): Model<Api>[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  /** Find by `(provider, id)`. Exact match only. */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return (
      this.authStorage.hasAuth(model.provider) || this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
    );
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: { apiKey?: string; headers?: Record<string, string>; authHeader?: boolean },
  ): void {
    if (!config.apiKey && !config.headers && !config.authHeader) return;
    this.providerRequestConfigs.set(providerName, {
      apiKey: config.apiKey ?? undefined,
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

  /** Resolve API key + request headers for a specific model. Triggers
   * `!cmd` / env-var / literal resolution on both apiKey and headers. */
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
      const apiKey =
        apiKeyFromAuthStorage ??
        (providerConfig?.apiKey
          ? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
          : undefined);
      const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );
      let headers =
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
    const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
    if (apiKey !== undefined) return apiKey;
    const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
    return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
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
    if (!config.apiKey && !config.oauth) {
      throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
    }
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
 * want to add a provider without dropping a models.json on disk. */
export interface ProviderConfigInput {
  baseUrl?: string;
  apiKey?: string;
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

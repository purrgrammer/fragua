// Judge provider records, read from the same `provider_config` table llm
// custom providers use, under a `judge:` key prefix.
//
// The prefix is load-bearing twice over. The two record shapes are
// incompatible, and `ModelRegistry`'s per-row `Value.Check` is non-strict, so
// an un-prefixed judge row validates as an llm provider and registers with zero
// models instead of being rejected. The table's primary key is the provider
// name, and a host that serves both an llm API and a System One API wants one
// row for each. Credentials are NOT prefixed: `provider_credentials('ollaya')`
// is one key for one host, and the existing `typesafe` row keeps working
// untouched.

import { JUDGE_BUILTIN_PROVIDERS, type JudgeProviderRecord } from "@fragua/core/handler";
import type { IProviderConfigStore } from "@fragua/store";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const JUDGE_PROVIDER_CONFIG_PREFIX = "judge:";

const ModelLimitsSchema = Type.Object(
  {
    "request-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "state-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "state-max-bytes": Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** Every field optional: a row may define a provider outright, or overlay a
 * built-in with the one number a measurement corrected. */
const JudgeProviderConfigSchema = Type.Object(
  {
    "base-url": Type.Optional(Type.String({ minLength: 1 })),
    auth: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("optional")])),
    "default-model": Type.Optional(Type.String({ minLength: 1 })),
    "usd-per-input-token": Type.Optional(Type.Number({ minimum: 0 })),
    "request-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "state-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "bytes-per-token": Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    "state-max-bytes": Type.Optional(Type.Integer({ minimum: 1 })),
    models: Type.Optional(Type.Record(Type.String(), ModelLimitsSchema)),
  },
  { additionalProperties: false },
);

export type JudgeProviderConfig = Static<typeof JudgeProviderConfigSchema>;

/** A row overlaying no built-in has to supply the fields that have no sane
 * default; `baseUrl` is the only one a record cannot be invented without. */
function overlay(id: string, base: JudgeProviderRecord | undefined, cfg: JudgeProviderConfig): JudgeProviderRecord {
  const models = cfg.models;
  const record: JudgeProviderRecord = {
    id,
    baseUrl: cfg["base-url"] ?? base?.baseUrl ?? "",
    auth: cfg.auth ?? base?.auth ?? "required",
    usdPerInputToken: cfg["usd-per-input-token"] ?? base?.usdPerInputToken ?? 0,
    requestTokenBudget: cfg["request-tokens"] ?? base?.requestTokenBudget ?? 0,
    stateTokenBudget: cfg["state-tokens"] ?? base?.stateTokenBudget ?? 0,
    bytesPerToken: cfg["bytes-per-token"] ?? base?.bytesPerToken ?? 0,
    stateMaxBytes: cfg["state-max-bytes"] ?? base?.stateMaxBytes ?? 0,
  };
  const defaultModel = cfg["default-model"] ?? base?.defaultModel;
  if (defaultModel !== undefined) record.defaultModel = defaultModel;
  const merged: Record<string, { requestTokenBudget?: number; stateTokenBudget?: number; stateMaxBytes?: number }> = {
    ...(base?.models ?? {}),
  };
  for (const [model, lim] of Object.entries(models ?? {})) {
    merged[model] = {
      ...(lim["request-tokens"] !== undefined ? { requestTokenBudget: lim["request-tokens"] } : {}),
      ...(lim["state-tokens"] !== undefined ? { stateTokenBudget: lim["state-tokens"] } : {}),
      ...(lim["state-max-bytes"] !== undefined ? { stateMaxBytes: lim["state-max-bytes"] } : {}),
    };
  }
  if (Object.keys(merged).length > 0) record.models = merged;
  return record;
}

export interface JudgeProviderRegistryResult {
  providers: Record<string, JudgeProviderRecord>;
  /** Per-row problems, joined. A corrupt row is skipped, never fatal — one bad
   * row must not take the working providers down with it. */
  error: string | null;
}

/** Built-ins merged under whatever `judge:` rows the store carries. */
export function loadJudgeProviders(store: IProviderConfigStore): JudgeProviderRegistryResult {
  const providers: Record<string, JudgeProviderRecord> = { ...JUDGE_BUILTIN_PROVIDERS };
  const errors: string[] = [];

  let rows: Array<{ provider: string; config: unknown }>;
  try {
    rows = store.listProviderConfigs();
  } catch (error) {
    return { providers, error: `Failed to read provider_config: ${error instanceof Error ? error.message : error}` };
  }

  for (const row of rows) {
    if (!row.provider.startsWith(JUDGE_PROVIDER_CONFIG_PREFIX)) continue;
    const id = row.provider.slice(JUDGE_PROVIDER_CONFIG_PREFIX.length);
    if (id.length === 0) {
      errors.push(`provider_config[${row.provider}]: empty judge provider id`);
      continue;
    }
    if (!Value.Check(JudgeProviderConfigSchema, row.config)) {
      const details =
        [...Value.Errors(JudgeProviderConfigSchema, row.config)]
          .map((e) => `  - ${e.path || "root"}: ${e.message}`)
          .join("\n") || "Unknown schema error";
      errors.push(`provider_config[${row.provider}]: invalid schema\n${details}`);
      continue;
    }
    const record = overlay(id, providers[id], row.config);
    if (record.baseUrl.length === 0) {
      errors.push(`provider_config[${row.provider}]: a new judge provider needs \`base-url\``);
      continue;
    }
    providers[id] = record;
  }

  return { providers, error: errors.length > 0 ? errors.join("\n") : null };
}

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

import { JUDGE_BUILTIN_PROVIDERS, type JudgeModelLimits, type JudgeProviderRecord } from "@fragua/core/handler";
import type { IProviderConfigStore } from "@fragua/store";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const JUDGE_PROVIDER_CONFIG_PREFIX = "judge:";

const ModelLimitsSchema = Type.Object(
  {
    "request-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "state-tokens": Type.Optional(Type.Integer({ minimum: 1 })),
    "state-max-bytes": Type.Optional(Type.Integer({ minimum: 1 })),
    // Per model, not only per provider: one backend can serve several
    // tokenizers, and the ratio differs by more than 2x between kinds of text.
    "bytes-per-token": Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
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
  const merged: Record<string, JudgeModelLimits> = { ...(base?.models ?? {}) };
  for (const [model, lim] of Object.entries(models ?? {})) {
    // A plain-object assignment to one of these invokes the setter instead of
    // creating an own property, poisoning every later lookup on the record.
    if (model === "__proto__" || model === "constructor" || model === "prototype") continue;
    // Field by field over the built-in entry, so a row correcting one measured
    // number does not silently drop that model's other limits.
    merged[model] = {
      ...merged[model],
      ...(lim["request-tokens"] !== undefined ? { requestTokenBudget: lim["request-tokens"] } : {}),
      ...(lim["state-tokens"] !== undefined ? { stateTokenBudget: lim["state-tokens"] } : {}),
      ...(lim["state-max-bytes"] !== undefined ? { stateMaxBytes: lim["state-max-bytes"] } : {}),
      ...(lim["bytes-per-token"] !== undefined ? { bytesPerToken: lim["bytes-per-token"] } : {}),
    };
  }
  if (Object.keys(merged).length > 0) record.models = merged;
  return record;
}

function isPlaintextRemote(baseUrl: string): boolean {
  if (!/^http:\/\//i.test(baseUrl)) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return true;
  }
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || /^127\./.test(host));
}

/** The fields a row defining a NEW provider must supply, with how to read each
 * off the overlaid record. `base-url` is checked separately because its empty
 * value is a string, not a zero. */
const REQUIRED_NEW_PROVIDER_FIELDS: ReadonlyArray<readonly [string, (r: JudgeProviderRecord) => number]> = [
  ["`request-tokens`", (r) => r.requestTokenBudget],
  ["`state-tokens`", (r) => r.stateTokenBudget],
  ["`bytes-per-token`", (r) => r.bytesPerToken],
  ["`state-max-bytes`", (r) => r.stateMaxBytes],
];

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
    if (id === "__proto__" || id === "constructor" || id === "prototype") {
      errors.push(`provider_config[${row.provider}]: "${id}" is not a usable judge provider id`);
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
    const base = providers[id];
    const record = overlay(id, base, row.config);
    if (record.baseUrl.length === 0) {
      errors.push(`provider_config[${row.provider}]: a new judge provider needs \`base-url\``);
      continue;
    }
    // A bare path or `file://` passes the non-empty check and then fails inside
    // `fetch` with an implementation-defined TypeError, far from the row.
    if (!/^https?:\/\//i.test(record.baseUrl)) {
      errors.push(`provider_config[${row.provider}]: \`base-url\` must be http(s), got "${record.baseUrl}"`);
      continue;
    }
    // The client sends `Authorization: Bearer <key>` whatever the scheme, so a
    // plaintext non-loopback URL with auth required would put the operator's
    // key on the wire unencrypted on every call.
    if (record.auth !== "optional" && isPlaintextRemote(record.baseUrl)) {
      errors.push(
        `provider_config[${row.provider}]: \`base-url\` "${record.baseUrl}" is plaintext http to a non-loopback host; ` +
          "a credential would cross the network unencrypted — use https, or set `auth: optional`",
      );
      continue;
    }
    // A row overlaying a built-in inherits every number it does not set. A row
    // defining a NEW provider inherits nothing, so an omitted budget is zero —
    // and a zero is not a permissive default, it is a broken one: the handler
    // rejects any state as "over the 0-byte cap" and the chunk planner sizes
    // every request at zero bytes, so the operator sees a capacity error that
    // says nothing about the missing config. Name the missing fields instead.
    const missing = REQUIRED_NEW_PROVIDER_FIELDS.filter(([, read]) => read(record) === 0).map(([key]) => key);
    if (base === undefined && missing.length > 0) {
      errors.push(`provider_config[${row.provider}]: a new judge provider needs ${missing.join(", ")}`);
      continue;
    }
    providers[id] = record;
  }

  return { providers, error: errors.length > 0 ? errors.join("\n") : null };
}

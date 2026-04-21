// `swarm providers add --custom` — interactively add a custom provider
// entry to ~/.swarm/models.json.
//
// A "custom provider" means an OpenAI-completions-compatible endpoint
// (Ollama, vLLM, LM Studio, a corporate proxy, etc.) that is NOT built
// into pi-ai.  The user supplies:
//   - provider name (slug, e.g. "ollama")
//   - base URL (e.g. "http://localhost:11434/v1")
//   - one or more model IDs (e.g. "llama3.1:8b")
//   - API key strategy: literal / env-var / shell-command / none
//
// The resulting entry is merged into providers.<name> in models.json.
// If the file already contains that provider the user is asked whether
// to overwrite or merge model lists.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import chalk from "chalk";
import prompts from "prompts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal models.json shape that we care about.  The registry accepts
 * more fields; we only write the ones we collect. */
export interface ModelsJson {
  providers: Record<string, ProviderEntry>;
}

export interface ModelEntry {
  id: string;
  name?: string;
  api: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderEntry {
  baseUrl: string;
  apiKey?: string;
  api?: string;
  compat?: Record<string, unknown>;
  models: ModelEntry[];
}

// ---------------------------------------------------------------------------
// Serialisation helpers (pure — no I/O, fully testable)
// ---------------------------------------------------------------------------

/** Parse models.json content.  Returns the object on success, or a
 * string describing the parse / schema error. */
export function parseModelsJson(content: string): ModelsJson | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return `JSON parse error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "models.json must be a JSON object";
  }
  const obj = parsed as Record<string, unknown>;
  if ("providers" in obj) {
    if (typeof obj["providers"] !== "object" || obj["providers"] === null || Array.isArray(obj["providers"])) {
      return `"providers" must be an object`;
    }
  }
  return { providers: (obj["providers"] ?? {}) as Record<string, ProviderEntry> };
}

/** Merge a new ProviderEntry into an existing ModelsJson.
 *
 * Strategy:
 *  - `overwrite=true` → replace the entire provider entry.
 *  - `overwrite=false` → keep existing fields; append models whose id
 *    is not yet present; overwrite models whose id already exists. */
export function mergeProviderEntry(
  existing: ModelsJson,
  providerName: string,
  entry: ProviderEntry,
  overwrite: boolean,
): ModelsJson {
  if (overwrite || !existing.providers[providerName]) {
    return {
      providers: {
        ...existing.providers,
        [providerName]: entry,
      },
    };
  }
  // Merge: keep existing top-level fields, upsert models by id.
  const base = existing.providers[providerName]!;
  const modelMap = new Map<string, ModelEntry>();
  for (const m of base.models ?? []) modelMap.set(m.id, m);
  for (const m of entry.models) modelMap.set(m.id, m);
  const merged: ProviderEntry = {
    ...base,
    // new values win for connection fields
    baseUrl: entry.baseUrl,
    ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
    ...(entry.api !== undefined ? { api: entry.api } : {}),
    ...(entry.compat !== undefined ? { compat: entry.compat } : {}),
    models: [...modelMap.values()],
  };
  return {
    providers: {
      ...existing.providers,
      [providerName]: merged,
    },
  };
}

/** Serialise ModelsJson → pretty-printed string. */
export function serialiseModelsJson(data: ModelsJson): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Input validation helpers (pure)
// ---------------------------------------------------------------------------

/** Validate a provider name slug.  Returns an error string or `true`. */
export function validateProviderName(value: string): true | string {
  if (!value || value.trim().length === 0) return "provider name must not be empty";
  if (!/^[a-z0-9_-]+$/i.test(value)) return "provider name must be alphanumeric (hyphens/underscores allowed)";
  return true;
}

/** Validate a base URL.  Returns an error string or `true`. */
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

/** Validate a model ID.  Returns an error string or `true`. */
export function validateModelId(value: string): true | string {
  if (!value || value.trim().length === 0) return "model ID must not be empty";
  return true;
}

// ---------------------------------------------------------------------------
// Default model-id → context-window / max-tokens heuristics
// ---------------------------------------------------------------------------

/** Infer sensible contextWindow / maxTokens defaults from a model id.
 * Returns undefined for both when the id gives no signal. */
export function inferModelDefaults(modelId: string): { contextWindow: number; maxTokens: number } {
  const id = modelId.toLowerCase();
  // Llama-family context windows
  if (id.includes("llama3") || id.includes("llama-3")) return { contextWindow: 128_000, maxTokens: 8_192 };
  if (id.includes("llama2") || id.includes("llama-2")) return { contextWindow: 4_096, maxTokens: 2_048 };
  if (id.includes("mistral") || id.includes("mixtral")) return { contextWindow: 32_768, maxTokens: 8_192 };
  if (id.includes("gemma")) return { contextWindow: 8_192, maxTokens: 4_096 };
  if (id.includes("phi")) return { contextWindow: 16_384, maxTokens: 4_096 };
  if (id.includes("qwen")) return { contextWindow: 32_768, maxTokens: 8_192 };
  // Fallback conservative defaults
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
// Build ProviderEntry from collected answers (pure)
// ---------------------------------------------------------------------------

export interface CustomProviderAnswers {
  providerName: string;
  baseUrl: string;
  apiKeyField: string | undefined; // undefined = no auth needed
  api: SupportedApi;
  modelIds: string[];
}

/** Build a ProviderEntry from wizard answers.  Pure — no I/O. */
export function buildProviderEntry(answers: CustomProviderAnswers): ProviderEntry {
  const { contextWindow: defaultCw, maxTokens: defaultMt } = inferModelDefaults(answers.modelIds[0] ?? "");
  const models: ModelEntry[] = answers.modelIds.map((id) => {
    const { contextWindow, maxTokens } = inferModelDefaults(id);
    return {
      id: id.trim(),
      name: id.trim(),
      api: answers.api,
      contextWindow: contextWindow ?? defaultCw,
      maxTokens: maxTokens ?? defaultMt,
    };
  });

  const entry: ProviderEntry = {
    baseUrl: answers.baseUrl,
    api: answers.api,
    models,
  };

  // apiKey field is required by models.json schema for custom providers;
  // use a placeholder sentinel when user says "no auth" so the schema
  // validator accepts the entry (the registry reads "" as "no key").
  if (answers.apiKeyField !== undefined) {
    entry.apiKey = answers.apiKeyField;
  } else {
    // No auth — pass an empty string; pi-ai treats absent/empty as no key.
    entry.apiKey = "";
  }

  return entry;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function readModelsJson(path: string): ModelsJson {
  if (!existsSync(path)) return { providers: {} };
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (content.trim().length === 0) return { providers: {} };
  const result = parseModelsJson(content);
  if (typeof result === "string") throw new Error(`Invalid models.json: ${result}`);
  return result;
}

function writeModelsJson(path: string, data: ModelsJson): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  writeFileSync(path, serialiseModelsJson(data), { encoding: "utf-8", mode: 0o644 });
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function providersAddCustomCommand(modelsJsonPath: string): Promise<number> {
  console.log(chalk.bold("Add a custom (OpenAI-compatible) provider\n"));

  // ── Step 1: provider name ──────────────────────────────────────────────
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

  // ── Step 2: existing provider conflict? ───────────────────────────────
  let overwrite = false;
  let existingData: ModelsJson;
  try {
    existingData = readModelsJson(modelsJsonPath);
  } catch (err) {
    console.error(chalk.red(String(err)));
    return 1;
  }

  if (existingData.providers[providerName]) {
    const { choice } = await prompts({
      type: "select",
      name: "choice",
      message: `"${providerName}" already exists in models.json — what should swarm do?`,
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

  // ── Step 3: base URL ──────────────────────────────────────────────────
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

  // ── Step 4: API shape ─────────────────────────────────────────────────
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

  // ── Step 5: API key / auth ────────────────────────────────────────────
  const { authChoice } = await prompts({
    type: "select",
    name: "authChoice",
    message: "Authentication",
    choices: [
      { title: "No auth required (local / trusted server)", value: "none" },
      { title: "Literal key — stored in models.json directly", value: "literal" },
      { title: "Environment variable — models.json stores the var name", value: "env" },
      { title: "Shell command — models.json stores !cmd; executed on read", value: "shell" },
    ],
  });
  if (authChoice === undefined) {
    console.log(chalk.dim("cancelled"));
    return 0;
  }

  let apiKeyField: string | undefined;
  if (authChoice === "literal") {
    const { value } = await prompts({
      type: "password",
      name: "value",
      message: "Paste the API key",
      validate: (v: string) => (v.length > 0 ? true : "must not be empty"),
    });
    if (!value) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    apiKeyField = value as string;
  } else if (authChoice === "env") {
    const { value } = await prompts({
      type: "text",
      name: "value",
      message: "Environment variable name (e.g. OLLAMA_API_KEY)",
      validate: (v: string) => (v.length > 0 ? true : "must not be empty"),
    });
    if (!value) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    apiKeyField = value as string;
  } else if (authChoice === "shell") {
    const { value } = await prompts({
      type: "text",
      name: "value",
      message: "Shell command (leading ! optional, e.g. op read 'op://vault/item/key')",
      validate: (v: string) => (v.length > 0 ? true : "must not be empty"),
    });
    if (!value) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    const raw = typeof value === "string" ? value.trim() : "";
    apiKeyField = raw.startsWith("!") ? raw : `!${raw}`;
  } else {
    // "none"
    apiKeyField = undefined;
  }

  // ── Step 6: model IDs ─────────────────────────────────────────────────
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
  let addAnother = true;
  while (addAnother) {
    const { more } = await prompts({
      type: "confirm",
      name: "more",
      message: "Add another model?",
      initial: false,
    });
    if (!more) {
      addAnother = false;
      break;
    }
    const { modelId } = await prompts({
      type: "text",
      name: "modelId",
      message: "Model ID",
      validate: (v: string) => validateModelId(v),
    });
    if (!modelId) break; // user cancelled
    modelIds.push(modelId as string);
  }

  // ── Build + write ─────────────────────────────────────────────────────
  const answers: CustomProviderAnswers = {
    providerName: providerName as string,
    baseUrl: baseUrl as string,
    apiKeyField,
    api: api as SupportedApi,
    modelIds,
  };

  const entry = buildProviderEntry(answers);
  const updated = mergeProviderEntry(existingData, providerName as string, entry, overwrite);

  try {
    writeModelsJson(modelsJsonPath, updated);
  } catch (err) {
    console.error(chalk.red(`Failed to write models.json: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  console.log();
  console.log(chalk.green(`✓ added provider "${providerName}" to ${modelsJsonPath}`));
  console.log(chalk.dim(`  models: ${modelIds.join(", ")}`));
  console.log(chalk.dim(`  base URL: ${baseUrl}`));
  console.log();
  console.log(chalk.dim(`Use \`swarm providers test ${providerName} ${modelIds[0]}\` to verify the connection.`));

  return 0;
}

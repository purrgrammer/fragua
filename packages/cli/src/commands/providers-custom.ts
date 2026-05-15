// `swarm providers add --custom` \u2014 interactively add a custom provider
// to the global swarm store's `provider_config` table.
//
// A "custom provider" means an OpenAI-completions-compatible endpoint
// (Ollama, vLLM, LM Studio, a corporate proxy, etc.) that is NOT built
// into pi-ai. The user supplies:
//   - provider name (slug, e.g. "ollama")
//   - base URL (e.g. "http://localhost:11434/v1")
//   - one or more model IDs (e.g. "llama3.1:8b")
//   - API shape (openai_completions | openai_responses)
//
// Credentials are NOT prompted here \u2014 a custom provider that needs
// auth uses the normal `swarm providers add <name>` flow into the
// `provider_credentials` table. Keyless providers (Ollama) need no
// credential row at all.

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

export interface ModelEntry {
  id: string;
  name?: string;
  api: string;
  contextWindow?: number;
  maxTokens?: number;
}

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
// Default model-id \u2192 context-window / max-tokens heuristics
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
// Build ProviderEntry from collected answers (pure)
// ---------------------------------------------------------------------------

export interface CustomProviderAnswers {
  providerName: string;
  baseUrl: string;
  api: SupportedApi;
  modelIds: string[];
}

/** Build a ProviderEntry from wizard answers. Pure \u2014 no I/O. The
 * resulting object is the JSON body persisted under
 * `provider_config.config`; no `apiKey` field (credentials live in
 * `provider_credentials`). */
export function buildProviderEntry(answers: CustomProviderAnswers): ProviderEntry {
  const models: ModelEntry[] = answers.modelIds.map((id) => {
    const trimmed = id.trim();
    const { contextWindow, maxTokens } = inferModelDefaults(trimmed);
    return {
      id: trimmed,
      name: trimmed,
      api: answers.api,
      contextWindow,
      maxTokens,
    };
  });

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
// Main wizard
// ---------------------------------------------------------------------------

export async function providersAddCustomCommand(): Promise<number> {
  console.log(chalk.bold("Add a custom (OpenAI-compatible) provider\n"));

  // \u2500\u2500 Step 1: provider name \u2500\u2500
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
    // \u2500\u2500 Step 2: existing provider conflict? \u2500\u2500
    let overwrite = false;
    let existingEntry: ProviderEntry | null = null;
    const existingRow = store.getProviderConfig(providerName as string);
    if (existingRow != null) {
      existingEntry = existingRow.config as ProviderEntry;
      const { choice } = await prompts({
        type: "select",
        name: "choice",
        message: `"${providerName}" already exists in provider_config \u2014 what should swarm do?`,
        choices: [
          { title: "Merge \u2014 keep existing models, add/update the ones I specify", value: "merge" },
          { title: "Overwrite \u2014 replace the entire provider entry", value: "overwrite" },
          { title: "Cancel", value: "cancel" },
        ],
      });
      if (!choice || choice === "cancel") {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
      overwrite = choice === "overwrite";
    }

    // \u2500\u2500 Step 3: base URL \u2500\u2500
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

    // \u2500\u2500 Step 4: API shape \u2500\u2500
    const { api } = await prompts({
      type: "select",
      name: "api",
      message: "API shape",
      choices: [
        {
          title: "openai_completions \u2014 Ollama, vLLM, LM Studio, most local servers",
          value: "openai_completions",
        },
        {
          title: "openai_responses \u2014 OpenAI Responses API (newer endpoints)",
          value: "openai_responses",
        },
      ],
    });
    if (!api) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }

    // \u2500\u2500 Step 5: model IDs \u2500\u2500
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

    // \u2500\u2500 Build + write \u2500\u2500
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
    console.log(chalk.green(`\u2713 added provider "${providerName}" to provider_config`));
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

// Known inference-provider metadata. A *provider* here is the API endpoint
// (anthropic, openrouter, bedrock, …) — distinct from the *model provider*
// (who made the weights), which is encoded in the model id itself. On
// aggregator providers like openrouter/bedrock/vertex, model ids carry the
// model-provider prefix (e.g. "anthropic/claude-haiku-4.5"); on direct
// providers they don't (e.g. "claude-haiku-4-5" on anthropic).
//
// pi-ai already bundles these providers + hundreds of models. We just surface
// the env-var dependency + a known-good default model per provider.

import { getModel } from "@mariozechner/pi-ai";

export interface ProviderInfo {
  /** Canonical inference-provider key accepted by pi-ai's getModel / stream. */
  name: string;
  /** Env var(s) pi-ai reads for credentials (first match wins). */
  envVars: string[];
  /** One-line description shown in error messages. */
  description: string;
  /** Default model id used when `--model` is omitted for this provider. */
  defaultModel?: string;
  /** A few more valid model ids shown in the "did you mean" error. */
  exampleModels?: string[];
}

export const KNOWN_PROVIDERS: ProviderInfo[] = [
  {
    name: "anthropic",
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    description: "Claude models direct from Anthropic",
    // 4.7 is latest (opus tier); haiku tops out at 4-5, sonnet at 4-6.
    // Override with --model for cheaper runs (e.g. --model claude-haiku-4-5).
    defaultModel: "claude-opus-4-7",
    exampleModels: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    name: "openai",
    envVars: ["OPENAI_API_KEY"],
    description: "OpenAI direct (Responses API)",
    defaultModel: "gpt-5.2",
    exampleModels: ["gpt-5.2", "gpt-4o", "gpt-4o-mini"],
  },
  {
    name: "google",
    envVars: ["GEMINI_API_KEY"],
    description: "Google Gemini direct",
    defaultModel: "gemini-2.5-flash",
    exampleModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  {
    name: "openrouter",
    envVars: ["OPENROUTER_API_KEY"],
    description: "OpenRouter gateway — one key for 300+ models across every major provider",
    defaultModel: "anthropic/claude-opus-4.7",
    exampleModels: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "google/gemini-2.5-pro",
      "openai/gpt-4o",
    ],
  },
  {
    name: "groq",
    envVars: ["GROQ_API_KEY"],
    description: "Groq inference (fast Llama, Mixtral, etc.)",
    defaultModel: "llama-3.3-70b-versatile",
    exampleModels: ["llama-3.3-70b-versatile"],
  },
  {
    name: "cerebras",
    envVars: ["CEREBRAS_API_KEY"],
    description: "Cerebras inference",
    defaultModel: "gpt-oss-120b",
    exampleModels: ["gpt-oss-120b", "qwen-3-235b-a22b-instruct-2507", "llama3.1-8b"],
  },
  {
    name: "xai",
    envVars: ["XAI_API_KEY"],
    description: "xAI Grok models",
    defaultModel: "grok-4",
    exampleModels: ["grok-4"],
  },
  {
    name: "mistral",
    envVars: ["MISTRAL_API_KEY"],
    description: "Mistral direct",
    defaultModel: "mistral-large-latest",
    exampleModels: ["mistral-large-latest", "mistral-small-latest"],
  },
  {
    name: "vercel-ai-gateway",
    envVars: ["AI_GATEWAY_API_KEY"],
    description: "Vercel AI Gateway (routes across providers with failover)",
    defaultModel: "anthropic/claude-opus-4.7",
    exampleModels: ["anthropic/claude-opus-4.7", "openai/gpt-4o"],
  },
  {
    name: "github-copilot",
    envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    description: "GitHub Copilot-backed models (OAuth flow)",
    defaultModel: "claude-sonnet-4",
    exampleModels: ["claude-sonnet-4", "gpt-4o"],
  },
  {
    name: "amazon-bedrock",
    envVars: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
    description: "AWS Bedrock (Claude, Titan, etc. via AWS auth)",
    defaultModel: "anthropic.claude-3-5-haiku-20241022-v1:0",
    exampleModels: ["anthropic.claude-3-5-haiku-20241022-v1:0", "anthropic.claude-3-5-sonnet-20241022-v2:0"],
  },
  {
    name: "google-vertex",
    envVars: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    description: "Google Vertex AI (enterprise Gemini)",
    defaultModel: "gemini-2.5-flash",
    exampleModels: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
];

export function getProviderInfo(name: string): ProviderInfo | undefined {
  return KNOWN_PROVIDERS.find((p) => p.name === name);
}

/** Check whether any of the provider's expected env vars is set. */
export function hasProviderCredentials(providerName: string): boolean {
  const info = getProviderInfo(providerName);
  if (!info) return true; // unknown provider — let pi-ai fail with its own error
  return info.envVars.some((v) => typeof process.env[v] === "string" && process.env[v] !== "");
}

/** First provider whose env var is already set. Useful for a helpful default. */
export function firstCredentialedProvider(): ProviderInfo | undefined {
  return KNOWN_PROVIDERS.find((p) => hasProviderCredentials(p.name));
}

/** Resolve the default model id for a given inference provider. */
export function defaultModelFor(provider: string): string | undefined {
  return getProviderInfo(provider)?.defaultModel;
}

/** Pre-flight model resolution: returns the pi-ai model or `null` if not found.
 * Unlike `getModel` directly, this swallows the throw path and treats any
 * non-object return as a miss — useful for early CLI validation. */
export function resolveModelOrNull(provider: string, modelId: string): unknown | null {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: getModel is typed for KnownProvider; we accept arbitrary strings so custom providers also resolve.
    const m = (getModel as any)(provider, modelId);
    if (!m || typeof m.api !== "string" || m.api === "" || m.api === "unknown") return null;
    return m;
  } catch {
    return null;
  }
}

// Known provider metadata: which env var feeds pi-ai for each provider, so
// the CLI can give actionable errors instead of silent "auth failed" noise.
//
// pi-ai already bundles these providers + hundreds of models. We just surface
// the env-var dependency to the user.

export interface ProviderInfo {
  /** Canonical provider key accepted by pi-ai's getModel / stream. */
  name: string;
  /** Env var(s) pi-ai reads for credentials (first match wins). */
  envVars: string[];
  /** One-line description shown in error messages. */
  description: string;
  /** Example model id users can pass via --model. */
  exampleModel?: string;
}

export const KNOWN_PROVIDERS: ProviderInfo[] = [
  {
    name: "anthropic",
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    description: "Claude models direct from Anthropic",
    exampleModel: "claude-haiku-4-5",
  },
  {
    name: "openai",
    envVars: ["OPENAI_API_KEY"],
    description: "OpenAI direct (Responses API)",
    exampleModel: "gpt-5.2",
  },
  {
    name: "google",
    envVars: ["GEMINI_API_KEY"],
    description: "Google Gemini direct",
    exampleModel: "gemini-2.5-pro",
  },
  {
    name: "openrouter",
    envVars: ["OPENROUTER_API_KEY"],
    description: "OpenRouter gateway — one key for 300+ models across every major provider",
    exampleModel: "anthropic/claude-sonnet-4.5",
  },
  {
    name: "groq",
    envVars: ["GROQ_API_KEY"],
    description: "Groq inference (fast Llama, Mixtral, etc.)",
    exampleModel: "llama-3.3-70b-versatile",
  },
  {
    name: "cerebras",
    envVars: ["CEREBRAS_API_KEY"],
    description: "Cerebras inference",
    exampleModel: "llama-4-scout-17b-16e-instruct",
  },
  {
    name: "xai",
    envVars: ["XAI_API_KEY"],
    description: "xAI Grok models",
    exampleModel: "grok-4",
  },
  {
    name: "mistral",
    envVars: ["MISTRAL_API_KEY"],
    description: "Mistral direct",
    exampleModel: "mistral-large-latest",
  },
  {
    name: "vercel-ai-gateway",
    envVars: ["AI_GATEWAY_API_KEY"],
    description: "Vercel AI Gateway (routes across providers with failover)",
  },
  {
    name: "github-copilot",
    envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    description: "GitHub Copilot-backed models (OAuth flow)",
  },
  {
    name: "amazon-bedrock",
    envVars: ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_BEARER_TOKEN_BEDROCK"],
    description: "AWS Bedrock (Claude, Titan, etc. via AWS auth)",
  },
  {
    name: "google-vertex",
    envVars: ["GOOGLE_CLOUD_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    description: "Google Vertex AI (enterprise Gemini)",
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

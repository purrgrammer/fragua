// env → store credential bridge. `fragua ci` runs against an ephemeral store
// with no `fragua providers add` history, so it seeds the store's
// `provider_credentials` rows from the conventional API-key env vars
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …) before the executor
// assembly reads them. Store-backed resolution then runs unchanged — this is
// a one-time seed, not a new resolution path on AuthStorage.
//
// The env→provider map is pi-ai's own `getEnvApiKey`, so CI and the rest of
// the ecosystem agree on which variable feeds which provider.

import { AuthStorage } from "@fragua/agent";
import type { IProviderCredentialStore } from "@fragua/store";
import { getEnvApiKey } from "@mariozechner/pi-ai";

// Providers whose credential reduces to a single stored api_key string.
// Deliberately excludes the ambient-credential providers (amazon-bedrock,
// google-vertex) — their `getEnvApiKey` returns an "<authenticated>" sentinel
// for ADC/AWS profiles rather than a key, which can't be stored as an api_key
// row — and the OAuth-only flows. Those need their own bridge if CI ever
// targets them.
const SEEDABLE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "vercel-ai-gateway",
  "zai",
  "mistral",
  "minimax",
  "moonshotai",
  "huggingface",
  "fireworks",
] as const;

/**
 * Seed `store`'s `provider_credentials` rows from the conventional API-key
 * env vars. Returns the providers that were seeded (had a usable key in env),
 * so the caller can surface "running against anthropic (from env)" or warn
 * when nothing resolved.
 */
export function seedCredsFromEnv(store: IProviderCredentialStore): string[] {
  const auth = AuthStorage.fromStore(store);
  const seeded: string[] = [];
  for (const provider of SEEDABLE_PROVIDERS) {
    const key = getEnvApiKey(provider);
    // `<authenticated>` is the ambient-credential sentinel — not a real key.
    if (!key || key === "<authenticated>") continue;
    auth.set(provider, { type: "api_key", key });
    seeded.push(provider);
  }
  return seeded;
}

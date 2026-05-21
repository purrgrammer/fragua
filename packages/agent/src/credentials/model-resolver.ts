// Model resolution helpers for fragua.
//
// pi-coding-agent's upstream resolver (model-resolver.ts) is much
// richer — pattern matching, alias-vs-dated-version preference,
// thinking-level suffix parsing. Fragua only needs the small subset
// wired into the workflow validator + daemon autodetect path today:
//
//   - defaultModelPerProvider: one valid id per KnownProvider, used
//     when the user omits --model.
//   - findByBareId: iterate the registry for "model `claude-opus-4-7`
//     under any provider" (catches workflow nodes that declare a model
//     but no provider).
//   - firstCredentialedProvider: the daemon's env-autodetect seed.
//
// The rest of upstream's resolver (resolveModelScope with ":high"
// suffixes and cross-provider ambiguity rejection) is skipped until
// fragua grows a surface that needs it — we can port it 1:1 when that
// happens.
//
// `defaultModelPerProvider` is taken verbatim from pi-coding-agent
// (packages/coding-agent/src/core/model-resolver.ts, MIT).

import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";

/** Default model id per known pi-ai provider. Used when the user
 * passes `--provider <name>` without `--model`. Kept in sync with
 * pi-coding-agent's upstream. Every entry must exist in pi-ai's
 * built-in registry (enforced by tests). */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  "azure-openai-responses": "gpt-5.2",
  "openai-codex": "gpt-5.4",
  google: "gemini-2.5-pro",
  "google-vertex": "gemini-3-pro-preview",
  "github-copilot": "gpt-4o",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
  // vercel-ai-gateway uses dotted form (not the hyphen form used by
  // the direct-Anthropic provider). The id below must exist in pi-ai's
  // generated model list for the active version pin.
  "vercel-ai-gateway": "anthropic/claude-opus-4.6",
  xai: "grok-4-fast-non-reasoning",
  groq: "openai/gpt-oss-120b",
  cerebras: "zai-glm-4.7",
  zai: "glm-5.1",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  moonshotai: "kimi-k2-thinking",
  "moonshotai-cn": "kimi-k2-thinking",
  huggingface: "moonshotai/Kimi-K2.5",
  opencode: "claude-opus-4-6",
  "opencode-go": "kimi-k2.5",
  "kimi-coding": "kimi-for-coding",
  deepseek: "deepseek-v4-pro",
  fireworks: "accounts/fireworks/models/deepseek-v4-pro",
  "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.5",
  "cloudflare-ai-gateway": "claude-3-5-haiku",
};

/** Find a model by bare id across every provider in the registry.
 * Returns the first match. Used by the workflow validator to accept
 * nodes that declared `model="claude-opus-4-7"` without a provider. */
export function findByBareId(registry: ModelRegistry, modelId: string): Model<Api> | undefined {
  return registry.getAll().find((m) => m.id === modelId);
}

/** Find every model with the given bare id. Used to detect ambiguity
 * (same id across multiple providers). */
export function findAllByBareId(registry: ModelRegistry, modelId: string): Model<Api>[] {
  return registry.getAll().filter((m) => m.id === modelId);
}

/** The first provider with any form of configured auth + a known
 * default model. Drives daemon autodetect when the user sets neither
 * `--provider` nor `--model`. */
export function firstCredentialedProvider(
  registry: ModelRegistry,
): { provider: string; model: Model<Api> } | undefined {
  const available = registry.getAvailable();
  for (const m of available) {
    const def = (defaultModelPerProvider as Record<string, string>)[m.provider];
    if (def && m.id === def) return { provider: m.provider, model: m };
  }
  // Fallback: no model matched the default list exactly — take any
  // available model of the first provider we see. Custom providers
  // aren't in defaultModelPerProvider, so this is the common path
  // for Ollama-only setups.
  const first = available[0];
  if (first) return { provider: first.provider, model: first };
  return undefined;
}

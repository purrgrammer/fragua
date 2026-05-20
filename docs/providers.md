# Inference provider ≠ model provider

swarm separates two concepts that are often conflated:

- **Inference provider** — the API endpoint / where the request goes. Set via the `llm_provider` node attribute. Choices: `anthropic`, `openai`, `google`, `openrouter`, `vercel-ai-gateway`, `amazon-bedrock`, `google-vertex`, `github-copilot`, `groq`, `cerebras`, `xai`, `mistral`.
- **Model provider** — who trained the weights. This is encoded *inside* the model id. On aggregator inference providers (openrouter, vercel-ai-gateway, bedrock, vertex) the model id is namespaced: `anthropic/claude-haiku-4.5`, `google/gemini-2.5-pro`. On direct providers (anthropic, openai, google) the id is bare: `claude-haiku-4-5`, `gpt-4o`.

## Setting provider + model

Provider and model are step attributes — they live next to the step that runs the LLM call (authored as `provider:` / `model:`, or shared across steps via a `defaults:` block):

```yaml
steps:
  # Direct Anthropic API — bare model id
  plan:
    type: llm
    provider: anthropic
    model: claude-opus-4-7

  # OpenRouter serving Anthropic — namespaced id
  plan2:
    type: llm
    provider: openrouter
    model: anthropic/claude-opus-4.7

  # OpenRouter serving Google
  plan3:
    type: llm
    provider: openrouter
    model: google/gemini-2.5-pro
```

Omit `model:` and swarm uses that provider's default (see
`swarm providers ls`). The daemon runs a pre-flight check against
pi-ai's registry before starting — bad combos fail immediately with a
list of valid ids, not after 30 retries.

## Credentials

Credentials live in the global swarm store (`~/.swarm/swarm.db`,
`provider_credentials` table). `swarm providers add [provider]` prompts
for the key and writes a row; `swarm providers login [provider]` runs
the OAuth flow for subscription-based providers. The daemon refuses to
run a node against a provider with no row in the table and points the
operator at `swarm providers add <provider>`.

Custom OpenAI-compatible endpoints (Ollama, vLLM, LM Studio, corporate
proxies) go through `swarm providers add --custom`, which writes a row
to the same global store — the `provider_config` table. The wizard
prompts for the slug, base URL, API shape, and one or more model ids;
it does NOT prompt for a key. Authenticated custom providers get a
credential row via the normal `swarm providers add <name>` flow; the
two writes are independent (a keyless Ollama is fine).

See the [CLI README](../packages/cli/README.md) for the full operations
reference.

# Inference provider ≠ model provider

fragua separates two concepts that are often conflated:

- **Inference provider** — the API endpoint / where the request goes. Set via the `provider` node attribute. Choices: `anthropic`, `openai`, `google`, `openrouter`, `vercel-ai-gateway`, `amazon-bedrock`, `google-vertex`, `github-copilot`, `groq`, `cerebras`, `xai`, `mistral`.
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

Omit `model:` and fragua uses that provider's default (see
`fragua providers ls`). The daemon runs a pre-flight check against
pi-ai's registry before starting — bad combos fail immediately with a
list of valid ids, not after 30 retries.

## The judge provider

`type: judge` steps do not use an inference provider. They call a System One
model — TypeSafe's Jev — through the `typesafe` provider id: one endpoint,
typed `choice` / `score` / `noul` answers with probabilities, no chat, no
tools. It never enters the model registry (`fragua providers ls` lists it only
once credentialed), it takes no `model:` beyond `jev-latest` / `jev-preview`,
and it is billed per input token only. Credential: `fragua providers add
typesafe`; smoke test: `fragua providers test typesafe` (one `noul` call,
prints the resolved model id and latency). In CI: `TYPESAFE_API_KEY`.

## Credentials

Credentials live in the global fragua store (`~/.fragua/fragua.db`,
`provider_credentials` table). `fragua providers add [provider]` prompts
for the key and writes a row; `fragua providers login [provider]` runs
the OAuth flow for subscription-based providers. The daemon refuses to
run a node against a provider with no row in the table and points the
operator at `fragua providers add <provider>`.

Custom OpenAI-compatible endpoints (Ollama, vLLM, LM Studio, corporate
proxies) go through `fragua providers add --custom`, which writes a row
to the same global store — the `provider_config` table. The wizard
prompts for the slug, base URL, API shape, and one or more model ids;
it does NOT prompt for a key. Authenticated custom providers get a
credential row via the normal `fragua providers add <name>` flow; the
two writes are independent (a keyless Ollama is fine).

See the [CLI README](../packages/cli/README.md) for the full operations
reference.

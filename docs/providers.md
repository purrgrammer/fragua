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

## Judge providers

`type: judge` steps do not use an inference provider. They call a System One
model: one endpoint, typed `choice` / `score` / `noul` answers with
probabilities, no chat, no tools. Judge backends never enter the model registry
— pi-ai has no models for them — so `fragua providers ls` lists each one with
its default model instead of a model count.

Two ship built in:

| id | endpoint | auth | default model | price |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai` | required | `jev-1.13.0` | per input token |
| `ollaya` | `http://127.0.0.1:11435` | optional | none — name `model:` | free |

[Ollaya](https://ollaya.dev) is a local runtime serving open decision models
behind an API wire-identical to TypeSafe's, so the same client speaks to both.
It accepts any non-empty key unless the server sets `OLLAYA_API_KEY`, which is
why its record marks auth optional: no credential row is needed, and
`fragua providers ls` shows it ready without one.

A step picks its backend with `provider:`, and the default comes from
`~/.fragua/config.yaml`:

```yaml
judge:
  provider: ollaya
  model: winnow:e4b
```

**Thresholds do not transfer between backends.** Every bound a workflow authors
was read against one model's answers, and published accuracy differs. Moving a
gate to another provider means re-reading its distribution —
`fragua judge calibrate` prints one line per `provider/model` and says so when
two answered under one bound.

Credential: `fragua providers add <id>` (only where auth is required). Smoke
test: `fragua providers test <id> [model]` — one `noul` call, prints the
resolved model id and latency. This is also the model pre-flight: a step's
`model:` is deliberately not validated statically, because a local runtime's
model list changes under `ollaya pull`. In CI: `TYPESAFE_API_KEY`,
`OLLAYA_API_KEY`.

### Adding a judge provider

Records live in the same `provider_config` table llm custom providers use,
under a `judge:<id>` key — the shapes are incompatible, and an un-prefixed row
would be read as an llm provider with zero models. There is no write verb yet;
the row is hand-written:

```json
{
  "base-url": "http://10.0.0.5:8080",
  "auth": "optional",
  "default-model": "kev",
  "request-tokens": 900,
  "state-tokens": 450,
  "bytes-per-token": 3.1,
  "state-max-bytes": 8192,
  "models": { "laya:en": { "request-tokens": 400, "state-tokens": 200 } }
}
```

Every field is optional: a row may define a provider outright or overlay a
built-in with the one number a measurement corrected. `models` matters —
Ollaya's context windows span 512 to 32768 tokens across its library, and a
`for-each` judge's chunk planner sizes against whichever entry applies.

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

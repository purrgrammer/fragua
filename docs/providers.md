# Inference provider ≠ model provider

swarm separates two concepts that are often conflated:

- **Inference provider** — the API endpoint / where the request goes. Set via the `llm_provider` node attribute. Choices: `anthropic`, `openai`, `google`, `openrouter`, `vercel-ai-gateway`, `amazon-bedrock`, `google-vertex`, `github-copilot`, `groq`, `cerebras`, `xai`, `mistral`.
- **Model provider** — who trained the weights. This is encoded *inside* the model id. On aggregator inference providers (openrouter, vercel-ai-gateway, bedrock, vertex) the model id is namespaced: `anthropic/claude-haiku-4.5`, `google/gemini-2.5-pro`. On direct providers (anthropic, openai, google) the id is bare: `claude-haiku-4-5`, `gpt-4o`.

## Setting provider + model

Provider and model are workflow attributes — they live next to the node that runs the LLM call:

```dot
// Direct Anthropic API — bare model id
plan [shape=codergen, llm_provider="anthropic", llm_model="claude-opus-4-7"]

// OpenRouter serving Anthropic — namespaced id
plan [shape=codergen, llm_provider="openrouter", llm_model="anthropic/claude-opus-4.7"]

// OpenRouter serving Google
plan [shape=codergen, llm_provider="openrouter", llm_model="google/gemini-2.5-pro"]
```

Omit `llm_model` and swarm uses that provider's default (see
`swarm providers ls`). The daemon runs a pre-flight check against
pi-ai's registry before starting — bad combos fail immediately with a
list of valid ids, not after 30 retries.

## Credentials

API keys are picked up from standard environment variables automatically
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY`, etc.). The daemon refuses to run a node against a
provider whose env var is missing and prints the exact variable name
you need.

For interactive setup, `swarm providers add [provider]` prompts for the
key and writes it under `~/.swarm/auth.json` (mode `0600`). Custom
OpenAI-compatible endpoints go through `swarm providers add --custom`,
which appends to `~/.swarm/models.json`. See the
[CLI README](../packages/cli/README.md) for the full operations
reference.

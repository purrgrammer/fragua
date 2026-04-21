# Inference provider ≠ model provider

swarm separates two concepts that are often conflated:

- **Inference provider** — the API endpoint / where the request goes. This is the `--provider` flag. Choices: `anthropic`, `openai`, `google`, `openrouter`, `vercel-ai-gateway`, `amazon-bedrock`, `google-vertex`, `github-copilot`, `groq`, `cerebras`, `xai`, `mistral`.
- **Model provider** — who trained the weights. This is encoded *inside* the model id. On aggregator inference providers (openrouter, vercel-ai-gateway, bedrock, vertex) the model id is namespaced: `anthropic/claude-haiku-4.5`, `google/gemini-2.5-pro`. On direct providers (anthropic, openai, google) the id is bare: `claude-haiku-4-5`, `gpt-4o`.

## Examples

```sh
# Direct Anthropic API — bare model id
--provider anthropic --model claude-opus-4-7

# OpenRouter serving Anthropic — namespaced id
--provider openrouter --model anthropic/claude-opus-4.7

# OpenRouter serving Google
--provider openrouter --model google/gemini-2.5-pro
```

Omit `--model` and swarm uses that provider's default (see `swarm providers`). The CLI runs a pre-flight check against pi-ai's registry before starting — bad combos fail immediately with a list of valid ids, not after 30 retries.

## Operations

- List all providers + their defaults + a few valid model ids:
  ```sh
  bun run packages/cli/bin/swarm.ts providers
  ```
- Add credentials for a built-in provider interactively:
  ```sh
  bun run packages/cli/bin/swarm.ts providers add [provider]
  ```
- Add a custom OpenAI-compatible endpoint to `models.json`:
  ```sh
  bun run packages/cli/bin/swarm.ts providers add --custom
  ```
  Prompts for a name, base URL, and API key, then appends the entry to `~/.swarm/models.json` so it is immediately usable as `--provider <name>`.
- Override per-node inside the workflow: `myNode [provider="openrouter", model="google/gemini-2.5-pro"]`.
- API keys are picked up from standard env vars automatically (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, etc.). The CLI refuses to run against a provider whose env var is missing and prints the exact variable name you need.
- Goal-gate retries are capped at 3 by default; override with `graph [max_goal_gate_retries = N]` in a workflow.

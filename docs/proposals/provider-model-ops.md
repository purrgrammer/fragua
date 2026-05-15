---
title: Per-model CLI ops for custom providers — add-model / rm-model / ls-models / edit-model
summary: "swarm providers add-model / rm-model / ls-models / edit-model lets operators manage individual model entries inside a custom provider's provider_config row without re-walking the whole `add --custom` wizard. Closes the UX regression that opened when `~/.swarm/models.json` stopped being hand-editable."
status: proposed
maturity: sketch
last-reviewed: 2026-05-15
---

# Per-model CLI ops for custom providers

> `provider-config-storage.md` moved custom-provider definitions into a `provider_config` table.
> Good for the architecture; loses one piece of UX. Pre-PR2 the operator could `$EDITOR
> ~/.swarm/models.json` and add a single model entry under an existing provider's `models` array.
> Post-PR2 there's no file to edit and no granular CLI — the only paths are re-walking the whole
> `swarm providers add --custom` wizard or hand-crafting a `sqlite3 UPDATE provider_config SET
> config=json_set(…)` invocation. Neither is acceptable for managing 14 models under a single
> custom provider.
>
> Add four focused commands.

## Why

- `swarm providers add --custom` walks an interactive wizard that creates a whole provider entry
  (baseUrl + api + auth + models[]). Adding one model means re-prompting through every step plus
  re-typing every existing model — or relying on `mergeProviderEntry`'s opaque "append if not
  overwrite" semantics, which still demand the full wizard walk.
- `~/.swarm/models.json` was hand-editable. Its replacement is a JSON blob in a SQL row. The right
  hand-edit equivalent is *commands*, not a CLI flag that opens an editor on the row.
- Custom providers in practice carry 5-20 model entries (the PPQ example carries 14). Operators
  add and remove them as providers ship and retire models. The blast radius of getting it wrong is
  exactly the one model, not the whole provider.

## Surface

Four new sub-verbs under `swarm providers`:

```
swarm providers ls-models <provider>
  # Print the model rows under <provider>, sorted by id.
  # Columns: id, name, contextWindow, maxTokens, reasoning, cost(in/out).

swarm providers add-model <provider> <id> [flags]
  # Append one model. <id> required; rest interactive unless flags provided.
  --name <str>            # display name (default: same as <id>)
  --context-window <n>    # default: inferModelDefaults heuristic
  --max-tokens <n>        # default: inferModelDefaults heuristic
  --reasoning             # boolean flag (default: false)
  --input <list>          # comma-sep "text,image" (default: "text")
  --cost-input <usd>      # per-million-token (default: 0)
  --cost-output <usd>     # per-million-token (default: 0)
  --yes / -y              # skip the confirmation prompt

swarm providers rm-model <provider> <id>
  # Remove one model. Interactive confirmation unless --yes.

swarm providers edit-model <provider> <id> [same flags as add-model]
  # Update one or more fields on an existing model. Only flag-provided
  # fields change; the rest preserve. Interactive walk if no flags.
```

`<provider>` is the name in `provider_config.provider`. The four verbs error with
`provider "<name>" not found in provider_config` if no row matches — operators run `swarm providers
ls` to see what's installed.

`add-model` rejects if `<id>` already exists in the provider's `models[]` (caller asked to edit, not
duplicate); `edit-model` rejects if `<id>` doesn't exist. Both messages tell the operator which
other verb to use.

## Implementation sketch

All four commands live in `packages/cli/src/commands/providers-custom.ts` (next to the existing
`providersAddCustomCommand`). Each follows the same shape:

1. `openGlobalStore()` → `store`.
2. `row = store.getProviderConfig(provider)` → 1 if missing → error + close.
3. `config: ProviderEntry = JSON.parse(row.config)`.
4. Mutate `config.models` in memory (filter / push / replace).
5. **Ajv-validate the new blob** against the agent layer's exported `ProviderConfigSchema`. The
   schema export already exists in `packages/agent/src/credentials/model-registry.ts`; the CLI
   imports it the same way the existing flow does.
6. `store.putProviderConfig(provider, JSON.stringify(config), now)` inside a `writeTxn`.
7. Print `✓ added model "<id>" to "<provider>"` / `✓ removed …` / `✓ updated …`.

Dispatcher wiring in `packages/cli/bin/swarm.ts`: extend the `providers` action switch to handle
`add-model | rm-model | ls-models | edit-model`. Existing pattern (single `[action] [target]
[extra]` positional walk) accommodates the verbs naturally if `<provider>` lands as `target` and
`<id>` lands as `extra` — but `add-model` / `edit-model` have multi-arg flag support that doesn't
fit the existing positional shape, so the cleaner move is to break out a dedicated CAC command
group for `providers` (`swarm providers add-model <provider> <id>`). Either works.

## Defaults

Reuse the existing `inferModelDefaults(modelId)` heuristic for interactive fallbacks — it already
ships sensible context/max-tokens guesses keyed off `llama3` / `mistral` / `phi` / `qwen` /
`gemma`. For everything outside the table, `{ contextWindow: 128_000, maxTokens: 16_384 }` matches
modern OpenAI-completion-compatible defaults.

For `cost`: default to `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`. The cost field is
informational (rolled into analytics rollups); zero is honest for self-hosted providers (Ollama,
vLLM). Operators set non-zero for cloud-proxy providers (PPQ, OpenRouter pass-through).

For `input`: default to `["text"]`. Multimodal providers (e.g. PPQ's `claude-opus-4.7` carries
`["text","image"]`) opt in via `--input text,image`.

## Tests

`packages/cli/test/providers-model-ops.test.ts`:

- `ls-models` on a provider with N models prints exactly N rows sorted by id.
- `ls-models` on a missing provider exits 1 with the canonical message.
- `add-model` happy path: writes the new model; Ajv passes; `updated_at` bumps.
- `add-model` rejects duplicate `<id>`.
- `add-model` flag set wins over heuristic defaults.
- `rm-model` happy path; rejects missing `<id>`.
- `edit-model` mutates only flag-supplied fields; everything else preserves byte-identical.
- All four return code 1 when `<provider>` doesn't exist.

End-to-end (manual): take the PPQ example, run `add-model ppq gpt-5.4-ultra --context-window
1000000 --max-tokens 131072 --reasoning --cost-input 4.5 --cost-output 18`, confirm the row in
`provider_config` carries 15 entries, run `ls-models ppq` and see the new entry.

## Out of scope

- **Bulk import.** A `swarm providers import-models <provider> <file.json>` could read a JSON
  array of model entries and bulk-add. Useful when a provider ships a model catalogue. Defer
  until the per-model commands prove their shape.
- **Model search / discovery.** Some providers expose a `/v1/models` endpoint; an `auto-fill` mode
  could pull the list and prompt. Same reason — defer.
- **`model-overrides` ops.** `provider_config.config.modelOverrides` is a separate map of cost /
  compat overrides on built-in models. Different concern; needs its own design pass.

## Risks

- **Flag combinatorial explosion on `edit-model`.** Caps at the 8 model-entry fields; manageable.
  If it grows, fall back to interactive `prompts` with a "field to edit?" picker.
- **Race against `add --custom`.** If `add --custom` and `add-model` run concurrently against the
  same provider, last-writer-wins on the full blob. SQLite's `BEGIN IMMEDIATE` in `writeTxn`
  serialises the writes, so neither row tears; one of them just gets overwritten cleanly. CLI
  operations are interactive and rare — acceptable.
- **Schema drift if `ProviderEntry` evolves.** The CLI builds the blob from a TypeScript type;
  Ajv-validates against the agent-layer schema. They have to stay in lockstep. The existing
  `add --custom` flow has the same coupling — this proposal doesn't make it worse.

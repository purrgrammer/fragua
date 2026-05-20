---
title: Honest token count on system-prompt rows
status: deferred
maturity: sketch
last-reviewed: 2026-05-04
rationale: The collapsed system-prompt row in `RunConversation.tsx` shows `{content.length} chars` — a measurement that's only weakly correlated with the thing operators actually care about (context-window pressure, cache budget, cost). A character count of a prompt full of file paths, code, and tool schemas tells you nothing actionable. Tokens are the right unit; the question is which tokenizer and where it runs.
---

# Honest token count on system-prompt rows

> Status: sketch. Deferred — chars/4 or a single client-side tokenizer is
> good enough for a label; full per-model accuracy is more infra than the
> UX warrants today. Keep this doc so the next person asking "why isn't
> this in tokens?" lands on the trade-offs instead of redoing the survey.

## Problem

`RunConversation.tsx:357` renders the collapsed system-prompt header as:

```tsx
<span>system prompt · {content.length.toLocaleString()} chars</span>
```

A system prompt is mostly file paths, code blocks, tool schemas, and
boilerplate skill bodies. Character count is roughly `tokens × 5` for
that mix and varies by content type — a 12 KB prompt full of code is
~3.5 KB of tokens; the same byte count of natural language is more like
2.5 KB. Operators reading this label want to know one of three things:

- **Context-window pressure.** "Is this prompt eating 30% of my window?"
- **Cache budget.** "Is this hot enough to warrant a cache write?"
- **Cost.** "Roughly how much does each turn pay just to send this?"

Characters answer none of these directly. Tokens answer all three.

## What's available

### pi-ai

No utilities. `dist/index.d.ts` exposes provider clients, `Type` /
`Static`, `register-builtins`, `stream`, `overflow.isContextOverflow`,
`utils/event-stream`, `utils/json-parse`. There's no `countTokens`,
no tokenizer surface, no provider-shaped count call. pi-ai only
operates on usage data the provider returns on real requests.

### Provider count endpoints

| Provider | Endpoint | Free? | Accuracy |
|---|---|---|---|
| Anthropic | `POST /v1/messages/count_tokens` | Yes (counts against rate limits, not billing) | Exact for the requested Claude model — Anthropic no longer publishes the Claude 3+ tokenizer, so this is the only honest path |
| Google Gemini | `POST .../models/{model}:countTokens` | Yes | Exact for the requested Gemini model |
| OpenAI | _(no count endpoint)_ | — | Tokenizer is published as `tiktoken` for client-side use |

### Client-side tokenizers

- **`gpt-tokenizer`** / **`js-tiktoken`** — pure-JS BPE for `cl100k_base`
  (GPT-3.5, GPT-4) and `o200k_base` (GPT-4o). ~250 KB gzipped (vocab
  tables). Exact for OpenAI; ~10–15% off for Anthropic and Gemini —
  honest order-of-magnitude across providers.
- **`@anthropic-ai/tokenizer`** — accurate only for Claude 2 and earlier;
  Anthropic doesn't bundle one for Claude 3+ and points users at
  `count_tokens`.

## Options, ranked by effort

### Option 1 — `chars / 4` heuristic (zero deps)

```tsx
const tokens = Math.round(content.length / 4);
<span>system prompt · ≈{tokens.toLocaleString()} tok</span>
```

Off by ~20–30% but keeps the right order of magnitude. No bundle cost,
no async, no infra. This is what we shipped before this proposal was
written.

### Option 2 — `gpt-tokenizer` lazy-loaded (small, honest, agnostic)

```tsx
const [tokens, setTokens] = useState<number | null>(null);
useEffect(() => {
  let cancelled = false;
  void import("gpt-tokenizer").then(({ encode }) => {
    if (!cancelled) setTokens(encode(content).length);
  });
  return () => { cancelled = true; };
}, [content]);
```

- Bundle: ~250 KB gzipped, but only loaded when at least one system-
  prompt row mounts. Could go further: only load when the user expands
  the row (deferred encoding behind a `Collapsible` open event).
- Accuracy: exact for OpenAI; within ~10% for Claude / Gemini. Right
  enough for the label.
- No server work, no provider rate-limit exposure, no auth coupling.

This is the recommended option when this comes off the deferred shelf.

### Option 3 — server-side route, model-sensitive

A new `POST /api/runs/:id/messages/:ordinal/count_tokens` endpoint that:

1. Looks up which provider/model assembled this system prompt (see
   _Provenance_ below).
2. Dispatches via pi-ai's provider auth surface:
   - Anthropic → `count_tokens` request with the prompt as a single
     `system` block.
   - Gemini → `countTokens` with a `Content` carrying the prompt.
   - OpenAI → run `tiktoken` server-side using the model's encoding.
3. Returns `{ tokens, source: "anthropic" | "gemini" | "tiktoken-cl100k" }`.

The web side prefers the server count when available, falls back to a
client tokenizer (Option 2) when the server can't classify the model.

Costs:
- One round-trip per system-prompt row that wants an honest number.
- Anthropic / Gemini round-trips count against provider rate limits.
- New handler in `@swarm/server`, including the provenance lookup.
- Cache layer on the server keyed by `(provider, model, hash(content))`
  to avoid repaying the API for identical prompts (which the bootstrap
  step makes likely — same skill bodies + tool schemas across runs).

### Option 4 — emit token count alongside the message at write time

The agent backend (`@swarm/agent`) already knows the provider and model
when it assembles a system prompt. It could call the provider's count
endpoint once at message-write time and store the result on the
`messages` row (new column `system_token_count INTEGER`). The UI reads
it like any other column.

Costs:
- Schema change on `messages` (new generated column or plain INTEGER).
- One count call per system-prompt write — paid by the agent process,
  not the UI session. Cheap if cached by content hash.
- No round-trip from the browser; label is instant on render.

This is the cleanest answer for full model-sensitive accuracy, but it's
a contract change (handler-contract.md, `@swarm/types` swarm-events
declaration merges if we want this to flow through events) and a schema
addition. Not worth it just to label a header.

## Provenance — which model produced this prompt?

The `messages` table records `role: "system"` with the prompt body; it
doesn't carry a model id. To pick the right tokenizer per row:

- The next assistant message in the same `nodeId` group carries the
  model — call it through `RunDetail.nodes` or query the `llm.*` events
  scoped to that node.
- The workflow node's `attrs` may pin a model (`provider` /
  `model`), with the project / global config defaulting otherwise.

Either path is doable but means the UI / server lookup is one indirection
deep, not a constant. This is the load-bearing reason Option 3 is more
work than the wire shape suggests.

## Recommendation

When this is reopened: **Option 2** (`gpt-tokenizer` lazy-loaded). It's
within ~10% of every major provider, costs no round-trip, and ships in
one PR. Add Option 4 (server-emitted count on the row) only if a
specific use case demands per-model exactness — operators picking
between `cl100k`-counted "≈4.2k tok" and Anthropic-exact "4,367 tok"
won't make different decisions for any normal label-grade context.

## Open questions

- **Where does the 250 KB tokenizer chunk land?** Vite's default
  splitting puts dynamic imports in their own chunk; that chunk is
  effectively cached after first load. But it ships once. Acceptable
  for `/runs/:id` views; not acceptable on `/`.
- **Re-encode on every render?** No — memoise by `content` string
  identity; system-prompt bodies are stable per row.
- **What about the user/assistant rows?** Out of scope here. Provider
  reports `usage.input_tokens` / `usage.output_tokens` on the assistant
  message we already render; if we want to surface those next to
  individual messages they're a free fetch from the `messages` table.
- **Should this whole label go away?** Possibly. The `Collapsible`
  trigger could carry zero metadata and let the operator expand to see
  the prompt itself. Counter: the pre-expand size hint is what stops
  someone from accidentally expanding a 40 KB block. Keep some signal;
  the question is which.

## What this depends on

- Nothing in the contract layer. This is a UI label.
- Option 4 alone touches `messages` schema → ARCHITECTURE.md §2 +
  handler-contract.md if we route the count through the handler API.

## What this enables

- A drift-lint or analytics tile on prompt size: "p95 system prompt
  this week was 4.8k tok, up from 3.2k last week" lives downstream of
  having an honest unit.
- Cache-budget heuristics ("this prompt is hot enough to warrant a
  cache write") are gated on the same unit.

# Advanced graph + node attributes

Three feature areas that don't ship in the day-one workflow but are worth reaching for once shape + edges are second nature.

---

## Retry policy presets

`retry_policy` (node) and `default_retry_policy` (graph) pick a backoff preset for handler-level retries. Combined with `max_retries`, they govern how the executor retries a single node when its outcome is RETRY (or it throws a retryable exception).

| Preset | maxAttempts | initial | factor | maxDelay | Use for |
|---|---|---|---|---|---|
| `none` (default) | 1 | 0 | 1.0 | 0 | Fail immediately. |
| `standard` | 5 | 200ms | 2.0 | 60s | General-purpose flake. |
| `aggressive` | 5 | 500ms | 2.0 | 60s | Unreliable upstreams. |
| `linear` | 3 | 500ms | 1.0 | 500ms | Fixed-delay polling. |
| `patient` | 3 | 2000ms | 3.0 | 60s | Long-running ops. |

Outcome flags that interact with retries:

- **`non_retryable`** (Outcome flag set by the handler) — short-circuits retries. Use for auth errors, 4xx, validation: don't retry, just fail.
- **`allow_partial`** (node attr, boolean) — converts retry-counter exhaustion into `PARTIAL_SUCCESS` instead of `FAIL`. The run continues forward as if it succeeded, with a note. Use when "best-effort" is acceptable.

Backoff happens *outside the executor slot*: a retrying run transitions to `paused_auto` (reason `handler_retry`), frees its concurrency slot, and the wake-pending sweeper re-queues it once the backoff timer elapses. Heavy backoff doesn't starve other runs.

W008 catches typos in preset names — the runtime falls back to `none` silently otherwise.

---

## Model stylesheet

The `model_stylesheet` graph attr provides CSS-like rules for `llm_model`, `llm_provider`, and `reasoning_effort` defaults across nodes. Saves you from per-node `model="…"` pins on every codergen.

```dot
graph [
  model_stylesheet = "
    *           { llm_provider: anthropic; llm_model: claude-sonnet-4-6; }
    .review     { llm_model: claude-opus-4-7; reasoning_effort: high; }
    #pick_best  { llm_model: claude-opus-4-7; }
  "
]
```

**Selectors** (specificity 0 → 3):

| Selector | Matches | Specificity |
|---|---|---|
| `*` | All nodes | 0 |
| `box` (or any shape name) | Nodes with that shape | 1 |
| `.classname` | Nodes whose `class` attr or subgraph-derived class includes `classname` | 2 |
| `#nodeId` | Specific node by id | 3 |

Properties: `llm_model`, `llm_provider`, `reasoning_effort` (low/medium/high). The recognised set is closed; `parseStylesheet` rejects others (E015).

**Resolution order** (highest precedence first):

1. Explicit node attr (`model = "…"`, `provider = "…"`)
2. Stylesheet rule (by specificity, later-wins on tie)
3. Daemon default

Apply once at the graph level, not per-node — that's the whole point. E015 fires on parse errors at validate-time so you don't ship a broken stylesheet.

---

## Subgraphs (scope + class derivation)

`subgraph cluster_<name> { … }` does two useful things:

1. **Scopes default attrs** to the contained nodes. A `node [thread_id="dev"]` block inside a subgraph applies that default to nodes declared inside, without leaking to siblings.
2. **Derives a class** named `<name>` (the part after `cluster_`) on every node inside, available to stylesheet `.classname` selectors and the node's `classes` array.

```dot
subgraph cluster_dev {
  node [thread_id = "dev"]                  // scope-local default

  implement [ prompt = "…" ]                // gets thread_id="dev" + class "dev"
  review    [ prompt = "…", goal_gate=true, retry_target = "implement" ]
}
```

The `change.dot` daily driver uses this to put `implement` + `review` in a shared `dev` thread automatically. Stylesheet rules on `.dev` will pick up both. A subgraph without the `cluster_` prefix uses its id as the derived class name.

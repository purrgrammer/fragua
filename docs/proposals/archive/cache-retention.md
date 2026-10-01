---
title: Configurable prompt-cache retention
summary: "fragua never sets pi-ai's `cacheRetention`, so every provider falls back to its short default (5 minutes on Anthropic). Repeated runs over one project — fragua's whole shape — therefore almost never reuse a cached tools+system prefix, no matter how stable those bytes are. This proposes a single `defaults.cache-retention: none | short | long` config key threaded to `streamSimple`, using pi-ai's already-provider-neutral vocabulary so fragua never branches on provider."
status: proposed
maturity: sketch
last-reviewed: 2026-07-29
---

> Status: sketch. Companion to the prefix-stability work (stable bytes are
> necessary but not sufficient — without retention they expire before the next
> run reads them).

## 1. The problem

`PiLlmBackend` calls `streamSimple` without a `cacheRetention` option:

```ts
// packages/agent/src/backend.ts
streamFn: (model, ctx, options) => streamSimple(model, ctx, { ...options, maxRetries: PROVIDER_SDK_MAX_RETRIES }),
```

pi-ai's Anthropic provider then resolves the default:

```js
// @earendil-works/pi-ai/dist/providers/anthropic.js
function resolveCacheRetention(cacheRetention) {
  if (cacheRetention) return cacheRetention;
  if (process.env.PI_CACHE_RETENTION === "long") return "long";
  return "short";
}
```

`short` is a 5-minute TTL. `long` is what emits `cache_control.ttl: "1h"`.
Nothing in `packages/` sets either the option or the env var.

**Consequence:** a cached prefix expires 5 minutes after the run that wrote it.
fragua's dominant usage is repeated runs over one project, spaced minutes to
hours apart — precisely the interval where a 5-minute TTL never pays and a
1-hour TTL almost always does. The prefix-stability work makes the bytes
identical across runs; retention decides whether anything is still there to
match against.

## 2. Why this stays provider-agnostic

pi-ai already owns the abstraction. `CacheRetention = "none" | "short" | "long"`
is a preference, not a TTL — "Providers map this to their supported values"
(`types.d.ts`). The mappings live in pi-ai, per API family:

| Retention | Anthropic | OpenAI-Responses | Provider without support |
|---|---|---|---|
| `none` | no `cache_control` | no cache key | ignored |
| `short` | `cache_control: {type: "ephemeral"}` | default | ignored |
| `long` | `+ ttl: "1h"` | `prompt_cache_retention: "24h"` | ignored |

Two rules keep fragua out of the mapping business:

1. **fragua passes the preference, never a TTL.** No `"1h"`, no `"24h"`, no
   provider name anywhere in fragua's config or code path.
2. **fragua does not probe capability.** pi-ai carries
   `supportsLongCacheRetention` per model and degrades `long` to the ephemeral
   marker when a model can't do better. A fragua-side check would duplicate a
   table that lives upstream and drift from it.

Adding a provider later requires no change here — it inherits whatever pi-ai
maps for its API family.

## 3. Surface

One key in the config cascade (`~/.fragua/config.yaml` overlaid by
`<project>/.fragua/config.yaml`), alongside the existing `defaults`:

```yaml
defaults:
  cache-retention: long   # none | short | long
```

Deliberately **not** proposed:

- **No node-level `cache_retention:` attribute.** Retention is a property of how
  often a *project* is run, not of what a node does. A per-node knob would let
  one node's setting silently split the cache namespace for the rest.
- **No CLI flag.** Nothing about it is per-invocation.

## 4. Threading

`config.defaults["cache-retention"]` → `buildExecutorDeps`
(`packages/cli/src/executor-deps.ts`, already where `defaults.provider` /
`defaults.model` are read) → a new `cacheRetention?: CacheRetention` on
`PiLlmBackendOptions` → the `streamSimple` options object in `backend.ts`.

Typed as pi-ai's `CacheRetention`, so an unsupported value is a typecheck error
rather than a string silently ignored at the provider boundary.

## 5. What default to ship

**Open question — this is the decision the proposal exists to frame.**

The cost asymmetry is real and provider-specific. On Anthropic, a cache *write*
bills at 1.25× base for the 5-minute marker and 2× base for the 1-hour marker;
reads are 0.1× either way. So `long` wins whenever a prefix is re-read at least
once within the hour, and loses when a prefix is written and never reused.

- `long` as the default matches fragua's usage shape (iterating on one project),
  and the prefix-stability work is what makes reuse likely enough to bet on.
- `short` as the default is the conservative read: it never costs more than
  today, and projects that iterate can opt in.

Recommendation: ship `long`, because a written-once-never-reused prefix is the
case the rest of this work is specifically eliminating. Worth revisiting against
the measured hit rate rather than deciding on priors.

## 6. Observability

Record the resolved retention on `llm.start` (next to `settings`) so a cache
miss in the event log is attributable. Without it, "why did this run miss?"
can't distinguish an expired prefix from a changed one — and those have
opposite fixes.

## 7. Test plan

- Config parse/merge: project overrides global; invalid value rejected at load.
- Threading: a backend constructed with `cacheRetention: "long"` passes exactly
  that through to `streamFn` options (assert on the options object; do not
  assert on provider payload — that is pi-ai's contract to keep).
- No provider branching: a source-scan lint, in the style of the existing
  discipline tests, asserting that no fragua source outside this doc mentions a
  literal TTL (`"1h"` / `"24h"`) or reads a provider name to decide retention.

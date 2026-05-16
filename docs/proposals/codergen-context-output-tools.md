---
title: Codergen context + output tools
status: in-progress
maturity: design
last-reviewed: 2026-05-17
---

# Codergen context + output tools

> Status: in-progress · Maturity: design
>
> Three force-included built-in tools (`context_set`, `emit_output`, `abort`)
> that make routing-context writes and structured outputs first-class for LLM
> steps, without interposing extra graph nodes. Pairs with an optional
> `output_schema` node attribute (ajv-validated) and operator-side intent duals
> for every LLM-emitting call.

---

## 1. Motivation

Today, `routingDelta` — the mechanism that writes key/value pairs into
`run_state.routing` and makes them reachable via `context.<key>` in edge
conditions and downstream prompt substitutions — can only be populated by
`tool`, `parallel`, and `wait.human` handlers. A codergen (box) node that
wants to classify its input and route downstream based on the result must
interpose a separate tool node to write `routingDelta` after the LLM finishes.
This makes the Anthropic Routing pattern (LLM classifier → conditional diamond)
second-class: the workflow graph has an extra hop, the tool node's output is
redundant prose, and the mental model breaks.

The handler-layer wiring already exists. At
`packages/agent/src/handler-bridge.ts:218`, `contextUpdatesToRouting(outcome.context_updates)`
maps an agent outcome's `context_updates` map directly into `routingDelta`.
The Attractor spec describes the same shape at §5.2 (`Outcome.context_updates`)
and Appendix C (the `status.json` contract). What's missing is the in-turn
mechanism for an LLM to _populate_ `outcome.context_updates` from inside its
run — today the only producer is the codergen backend reading a status-file-
like channel, which is fragile and invisible in the tool trace. Exposing the
capability as a first-class tool fixes both problems: the LLM gets an explicit,
introspectable call, and the wiring is no different from any other
`routingDelta` write.

The second gap is the `$<id>.output` contract. Today a codergen node's output
is the verbatim final assistant text, stored as a `text/plain` artifact
(`outputRef` in `handler-bridge.ts`). Downstream nodes that reference
`$<nodeId>.output` get that raw string. For prose that's fine. For structured
data — JSON objects, classification labels, scored lists — the string is
fragile: downstream substitution has to parse it, JSON embedded in prose
silently loses schema, and there's no way for the workflow runtime to validate
the shape. An `emit_output` tool that writes a first-class artifact (with
optional schema validation) fixes this gap while keeping the prose fallback for
nodes that don't call it.

---

## 2. Tool specs (v1)

All three tools are **force-included** on every codergen call — parallel to
`abort` in `packages/agent/src/backend.ts`. They survive `allowed_tools` /
`denied_tools` filtering because they are part of the codergen execution
contract, not user-selectable capabilities. The LLM sees them in its tool
catalogue on every turn.

### 2.1 `context_set`

**Signature (TypeBox):**

```ts
Type.Object({
  key:   Type.String(),                    // no dots; single identifier
  value: Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
  ]),
})
```

**Semantics.** Additive; many calls per turn are expected. Last-write-wins per
key within a turn (and across turns — the routing store is append-and-update).
Keys must be a single identifier with no dots: a dot in a key would collide with
the `context.foo.bar` path-parsing that edge conditions use to traverse nested
routing maps, producing silent ambiguity. Values are scalars only in v1; object
and array values are deferred (§6).

Key validation (no dots) is enforced at tool-call time — the tool returns a
structured error without writing the key, letting the LLM retry in-turn.

**Emission.** Writes via `routingDelta` through the existing
`contextUpdatesToRouting` path in the handler bridge. Emits
`fact.context_written { source: "agent", nodeId, key, value, prevValue?, ts }`
so the audit log records every write with its prior value.

**Tool description (catalogue prose — what the LLM sees):**

```
context_set({ key, value })

Set a routing-context key so downstream nodes and edge conditions can read it
via context.<key>. Use this when you have classified the input, chosen a
branch, scored an outcome, or computed any value the rest of the workflow needs.

You may call this tool multiple times in a single turn to set multiple keys.
Each call is additive; the last write to a given key wins.

Rules:
- key must be a single identifier — no dots (e.g. "severity", not "issue.severity").
- value must be a string, number, boolean, or null. Objects and arrays are not
  supported yet.

Example: context_set({ key: "category", value: "billing" })
```

---

### 2.2 `emit_output`

**Signature (TypeBox):**

```ts
Type.Object({
  data: Type.Union([
    Type.String(),
    Type.Record(Type.String(), Type.Unknown()),   // object
    Type.Array(Type.Unknown()),                   // array
  ]),
})
```

**Semantics.** One call expected per turn; last-write-wins (so a node that
self-corrects mid-turn only persists the final call). When `emit_output` is
called, `$<this-node>.output` resolves to `data` — JSON-path-traversable when
`data` is an object or array (e.g. `$classify.output.label`). When `emit_output`
is _not_ called:

- If no `output_schema` is set on the node → falls back to the final assistant
  text (current behaviour, fully backward-compatible).
- If `output_schema` is set → treated as a failed outcome. The LLM agreed to
  produce a schema-conforming value and did not; the handler bridge surfaces
  this as `outcomeStatus: "fail"` with a `failureReason` naming the missing
  call. A `condition="outcome=fail"` edge can route to a retry or error node;
  without one, the executor halts.

**Storage.** Stored via the existing `outputRef` artifact path (`ctx.artifacts.put(
"output", JSON.stringify(data), "application/json", { replace: true })`). The
executor's `nodeOutputs` fold already dereferences this artifact when resolving
`$<nodeId>.output` — no executor change needed.

**Validation.** When `output_schema` is set, the tool handler runs ajv
synchronous validation against `data` before writing the artifact. On failure
the tool returns:

```json
{
  "ok": false,
  "errors": [
    { "path": "/label", "message": "must be string" }
  ]
}
```

The LLM can correct the value and call `emit_output` again within the same
turn. Repeated validation failures do not halt the node — only a missing
`emit_output` call at turn-end causes failure. This gives the LLM a retry loop
within a single turn budget.

**Tool description (catalogue prose — what the LLM sees):**

```
emit_output({ data })

Emit this node's structured output. Downstream nodes reference it via
$<this-node>.output — and, if data is an object or array, can traverse
specific fields via JSON path (e.g. $classify.output.label).

Call this tool exactly once. If you call it multiple times, the last call
wins. If this node declares output_schema and you do not call emit_output,
the node is treated as failed.

When no output_schema is declared, not calling this tool is fine — the
node's output falls back to your final assistant text. Prefer emit_output
whenever you are producing structured data.

data may be a string, a JSON object, or a JSON array.
```

---

### 2.3 `abort`

Unchanged from the current built-in. Included here for completeness: `abort` is
the _failure_ path (unrecoverable stop), `emit_output` is the _success_ path
(structured completion), and `context_set` is the _data-share_ path (routing
context). The three are orthogonal and may all be called in the same turn (e.g.
set several context keys then emit output, or set context then abort with a
reason that references the classified value).

**Tool description (catalogue prose — unchanged):** see `packages/agent/src/backend.ts`.

---

### 2.4 Force-include rationale

These tools are injected into the tool catalogue by the codergen backend before
`allowed_tools` / `denied_tools` filtering is applied, using the same injection
point as `abort`. Authors cannot remove them by listing them in `denied_tools`.
The rationale: they are structural properties of the step execution contract
(like `abort`), not domain capabilities. A workflow that denies `context_set`
would silently break edge routing; the validator will warn (W-code, see §5) when
a node uses `denied_tools` that includes a built-in.

---

## 3. `output_schema` node attribute

**Declaration (DOT):**

```dot
classify [
  shape=box,
  prompt="...",
  output_schema="{\"type\":\"object\",\"properties\":{\"label\":{\"type\":\"string\"},\"confidence\":{\"type\":\"number\"}},\"required\":[\"label\",\"confidence\"]}",
]
```

Or via multi-line string escape — authors typically extract it to a `context`
block or use the JSON IR form (see `json-ir-canonical.md`) once that proposal
ships.

**Registration-time.** The DOT parser passes `output_schema` through
`NodeAttrs` as an opaque string (it is already in `KNOWN_NODE_ATTRS` after
this feature lands). At workflow registration (`packages/core/src/engine/validator.ts`)
the validator calls `ajv.compile(JSON.parse(value))` inside a try/catch:

- JSON parse failure → **E017** ("output_schema is not valid JSON").
- ajv compile failure → **E017** ("output_schema is not a valid JSON Schema:
  `<ajv message>`").

This catches typos at upload time, not first-run time.

**Runtime.** The codergen backend reads `output_schema` from the node
definition. When present:

1. ajv is instantiated once per handler invocation with the parsed schema.
2. Each `emit_output` call synchronously validates `data` against the schema.
3. On failure the tool returns the structured error (§2.2) without writing the
   artifact — the LLM retries within the turn.
4. On success the artifact is written and the run proceeds normally.
5. If `emit_output` was never called at turn-end and `output_schema` is set, the
   bridge sets `outcomeStatus: "fail"` with a descriptive `failureReason`.

**Why ajv / why JSON Schema.**
pi-ai uses TypeBox throughout; TypeBox's output IS JSON Schema Draft 7. Pinning
ajv means: (a) the same schema string a TypeBox author would write compiles
directly, (b) when v2 lands (§7) and the schema flows to the provider's
`response_format`, swarm passes the identical string unchanged — no conversion
layer. The `emit_output` validator becomes belt-and-suspenders over the
provider's own enforcement.

**Dependency pin:** `ajv@^8` — JSON Schema Draft 7/2019-09/2020-12 validator;
aligns with the JSON Schema Draft 7 superset that TypeBox emits, and the version
providers (Anthropic, OpenAI) reference in their structured-output docs.

---

## 4. Operator parity

Every LLM-emitting tool has a dual operator intent so that humans (and
automation) can inject or override context and output outside the normal
execution path. Both write through the same `routingDelta` path so the
audit log records `source: "agent" | "operator"` symmetrically — this
uniformity is what a future fork-from-step needs: replay a node with a
different context value, observe the counterfactual branch.

### 4.1 `intent.context_set` — POST /runs/:id/context

**Request body:**

```json
{ "key": "severity", "value": "high" }
```

**Implementation note.** Before adding this route, grep
`packages/server/src/store/runs-routes.ts` and `routes.ts` for an existing
context-write endpoint — extend it rather than add a duplicate if one exists.
The route validates via a Typebox body schema in `packages/server/src/schemas.ts`,
folds the intent via `intent-fold.ts`, and writes `routingDelta`. Emits
`fact.context_written { source: "operator", runId, key, value, prevValue?, ts }`.

**Response:** 202 Accepted with no body (intent enqueued, not yet applied).

### 4.2 `intent.output_set` — POST /runs/:id/output?node=\<nodeId\>

**Request body:**

```json
{ "data": { "label": "billing", "confidence": 0.93 } }
```

This is a new endpoint. It stores `data` as the node's output artifact
(same `outputRef` path as `emit_output`) and emits
`fact.output_emitted { source: "operator", runId, nodeId, ts }`. Downstream
`$<nodeId>.output` substitution resolves through the same artifact dereference
path — no substitution engine change required.

**Schema validation.** If the node has `output_schema` set, the server validates
the operator's `data` against it before enqueueing the intent. A 422 Unprocessable
Entity with the ajv errors is returned on failure — operators get the same
structured error the LLM sees, for the same in-flight correction loop.

**Response:** 202 Accepted.

---

## 5. Validator additions

Codes are assigned at implementation time after confirming the current watermarks
(`E016`, `W015`, `W017`). The next available codes are **E017** and **W018**.

| Code | Severity | Trigger | Gate |
|------|----------|---------|------|
| E017 | error | `output_schema=` is not valid JSON, or does not ajv-compile as JSON Schema | registration (`validator.ts`) |
| W018 | warning | A downstream `$<id>.output.<path>` reference names a path that the upstream node's `output_schema` does not permit (static dead-reference detection) | reference-resolution pass; **can defer to follow-up** |

**Same-PR obligation when codes land.** Adding E017 / W018 requires updating
the validator-codes table in `.agents/skills/swarm-author/references/validator-codes.md`
and the range summary in `.agents/skills/swarm-author/SKILL.md` (currently
"E001–E016 / W001–W017") in the same PR. The enum-consumer grep in AGENTS.md
ground rule #1 applies: search `packages/` for `"E016"` / `"W017"` consumer
sites to find any hardcoded upper-bound checks.

**`output_schema` in `KNOWN_NODE_ATTRS`.** The attribute must be added to the
whitelist in `validator.ts:22` so it does not trigger W013 (unrecognised
attribute). This is a one-liner in the same file as E017.

### 5.1 Dropping W015

W015 currently warns when a `tripleoctagon` (`parallel.fan_in`) node has
`prompt=` set, on the grounds that `fan_in` is a deterministic heuristic ranker
and the prompt is never read. The G3 design (separate proposal / change-set)
supersedes this by making fan-in LLM evaluation a first-class feature — at that
point `prompt=` on a fan-in node is _correct_ and the warning is actively
harmful. W015 should be removed (or downgraded to informational) in the same PR
that implements G3, not here. This proposal records the intent so the G3
implementer has the pointer.

---

## 6. What is deferred

- **`emits_context` declaration on nodes.** A static annotation that says "this
  codergen node writes `context.foo` and `context.bar`" would enable the
  validator to catch missing wiring. Deferred until context-typing lands as a
  first-class feature — the shape isn't stable enough to pin.

- **`partial_success` / `retry` as LLM-callable outcomes.** These outcomes are
  expressible today via `context_set` + `condition=` edges on outgoing arcs —
  set `context.retry_reason`, use `condition="context.retry_reason != null"` to
  route to a retry node. A dedicated tool would be ergonomic but isn't needed
  for v1.

- **Native provider-side structured outputs.** Anthropic and OpenAI both support
  `response_format: json_schema`. Exposing `output_schema` at generation time
  requires an upstream pi-ai PR (Typebox interop is trivial — the schema string
  passes through unchanged). This is the v2 path (§7).

- **Sub-pipeline nodes and `stack.manager_loop`.** Explicit non-goals per
  existing validator comments. These require the sub-run executor model
  (`parallel.md`) to land first and are out of scope for this proposal.

---

## 7. V2 upgrade path

When pi-ai gains a `responseFormat: { type: "json_schema", schema: object }`
channel (tracking both Anthropic's and OpenAI's current APIs), the codergen
backend forwards `output_schema` verbatim at generation time. The provider
enforces the schema before a token is sampled; the LLM never produces
invalid output in the first place.

In that world:

- `emit_output` becomes a thin shim — the LLM's response is already the
  validated JSON, and the tool call just surfaces it explicitly in the trace.
  Alternatively `emit_output` is silently called by the backend when the
  provider returns a `stop_reason: "tool_use"` + JSON response, with no
  visible LLM call.
- Runtime ajv validation in swarm becomes belt-and-suspenders: still runs,
  still rejects, but should never fire in normal operation.
- The `output_schema` DOT attribute and all author-facing tooling are unchanged.
  The only implementation delta is in `packages/agent/src/backend.ts` where the
  generation request is assembled.

Authors do not change a thing. This is the deliberate v1 → v2 invariant: the
tool-based contract today maps onto the provider-native contract tomorrow without
a workflow rewrite.

---

## 8. Same-PR doc obligations (when implementation lands)

The following updates are **not** part of this proposal PR; they are mandatory
co-updates for the implementation PR:

- **`docs/SPEC.md` §3** (built-in tools list) — add `context_set` and
  `emit_output` to the catalogue of force-included tools alongside `abort`.

- **`docs/ARCHITECTURE.md` §3** (event taxonomy) — add
  `fact.context_written { source, nodeId, key, value, prevValue?, ts }` and
  `fact.output_emitted { source, nodeId, ts }` as new fact types.

- **`docs/handler-contract.md`** — document the updated `routingDelta` semantics
  (now also produced by LLM tool calls, not just handler return values) and the
  `emit_output` → `outputRef` artifact path contract.

- **`.agents/skills/swarm-author/SKILL.md`** (and
  `references/validator-codes.md`) — add E017 / W018 to the validator-codes
  table and extend the code range in the summary line; add `output_schema` to
  the attribute reference; document `context_set` / `emit_output` in the tool
  catalogue section. This update belongs in the final post-engine-work sweep
  once the API is stable.

---

## 9. Open questions

**Q1 — Key namespacing.** Should `context_set` keys be namespaced per-node
(`context.<nodeId>.<key>`) to prevent accidental cross-node clobber, or stay
flat (`context.<key>`) as the existing `context.foo` path-parsing implies?

Recommendation for v1: **flat**, matching today's routing map shape. The author
is responsible for choosing non-colliding key names, same as they are for any
global DOT attribute. If collision becomes a real problem in practice, namespaced
keys can be added as an opt-in `context_ns_set` variant without breaking
existing `context_set` callers.

**Q2 — `emit_output` data size cap.** The existing `events.payload` cap is 4 KB;
the artifact store has a separate ceiling. Should `emit_output` enforce a
per-call data size limit, and what halt reason fires on overflow?

Recommendation: defer to `cap-overflow.md`, which owns the spill/halt path for
both `run_state.routing` (8 KB) and `messages.content` (1 MiB). Add
`emit_output` data size to cap-overflow's scope when that proposal is
implemented. For v1, reject oversized payloads with a structured tool error
(same pattern as schema validation failure) and let the LLM retry with a smaller
value.

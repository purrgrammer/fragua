# Expressions

The IR uses a small set of declarative expression languages instead of TS functions, so it serializes, hashes, and replays portably. Five expression types, each with its own grammar; the SDK desugars author-friendly forms to these at `.compile()` time.

The bet behind the constraint: keep the IR pure data so it round-trips through JSON, hashes deterministically, replays under any runtime, and emits from non-TS clients eventually. Authors who need richer logic write a `Task` upstream that prepares typed input; the LLM / Wait / Map node consumes the result via simple template.

## TemplateExpr — string templates with placeholders

Where it appears: `LLM.prompt.{system,user}`, `Wait.human.prompt.{question,description}`, anywhere the IR carries author-supplied text that substitutes typed input.

```
template    ::= (literal | placeholder)*
placeholder ::= "${" path ("|" filter)* "}"
path        ::= segment ("." segment | "[" integer "]")*
segment     ::= identifier
filter      ::= identifier ("(" arg ("," arg)* ")")?
literal     ::= any text not matching placeholder syntax
```

Example IR:

```
"Task: ${input.task}\nFiles: ${input.files | join(', ')}\nSeverity: ${input.severity | default('low')}"
```

### Filter registry (runtime-provided)

| Filter | Signature | Effect |
|---|---|---|
| `join(sep)` | `T[] → string` | Array → string joined by `sep` |
| `default(value)` | `T \| null \| undefined → T` | Substitute when missing |
| `upper` / `lower` | `string → string` | Casing |
| `truncate(n)` | `string → string` | First N chars |
| `json` / `jsonPretty` | `T → string` | Serialize to JSON |

Not user-extensible. For richer transformations, author a `Task` upstream that prepares the value.

### What's deliberately missing

- **Conditionals** (`if`/`else`). Move logic upstream.
- **Loops** (`{{#each}}`). Use a filter that joins, or move logic upstream.
- **Function calls** outside the filter registry. By design.

## PathExpr — typed-input field access

A pure path into typed `I`. Used wherever the IR needs "pull a value out."

```
path     ::= root ("." segment | "[" indexer "]")*
root     ::= "input" | "outcome" | "value" | "error"
segment  ::= identifier
indexer  ::= integer | "*"
```

Examples:
- `input.task`
- `input.files[0]`
- `input.subtasks[*].config` — wildcard yields an array
- `value.verdict` — read from `Outcome<O>.value`
- `outcome.tag` — read the discriminator

## TransformExpr — output → input shape change

Edge transforms and `Map.extract` use this. More expressive than PathExpr.

```
transform ::= path                                # bare path: pull a value
            | "pick(" path ("," path)* ")"        # keep listed fields
            | "omit(" path ("," path)* ")"
            | "set(" path "," value ")"           # set to a literal OR a path-ref
            | "rename(" "{" identifier ":" identifier ("," identifier ":" identifier)* "}" ")"
            | "merge(" transform "," transform ")"
            | "construct(" "{" identifier ":" value ("," identifier ":" value)* "}" ")"
            | "take(" path "," integer ")"        # first N elements
            | "drop(" path "," integer ")"        # skip first N
            | "json(" path ")"                    # serialize value to JSON string
            # array operations (operate on array-typed paths; element root for inner expressions)
            | "length(" path ")"                  # array → integer
            | "count(" path "," predicate ")"     # array → integer (matching elements)
            | "filter(" path "," predicate ")"    # array → filtered array
            | "map(" path "," transform ")"       # array → projected array (per-element shape change)
            | "flatten(" path ")"                 # nested array → flat array (one level)
value     ::= literal | path-ref
literal   ::= STRING | NUMBER | BOOL | NULL
path-ref  ::= "{" "ref" ":" path "}"              # value pulled from a path
```

### Array operations

The most common "I want to filter / count / check existence" cases get first-class DSL forms instead of pushing to a Task. The element under predicate is rooted at `element.<path>`:

```ts
// "Filter findings to high+critical"
filter(value.findings, in(element.severity, ['high', 'critical']))

// "Count critical findings"
count(value.findings, eq(element.severity, 'critical'))

// "Length of files array"
length(value.files)
```

For per-element shape transforms, the DSL's `map(path, transform)` covers the common cases. `element.<path>` roots inner expressions to the element under projection:

```ts
// "Project findings to {file, severity} for the reviewer"
map(value.findings, construct({
  file:     element.location,
  severity: element.severity,
}))
```

`Map` (the node kind) remains the right answer when each element needs an LLM call, a Task, or a sub-graph — anything beyond pure shape projection. The DSL's `map` is for the cheap per-element record projections that don't justify a sub-Run per element.

### `set` and `construct` for computed fields

`set(path, value)` and the field values in `construct({...})` accept either a literal OR a path-ref:

```
set(decision, { ref: value.choice })              # decision = value.choice (path-ref)
set(approved, true)                                # approved = true (literal)

construct({
  verdict: { ref: value.verdict },                 # from path
  reviewer: 'sonnet',                              # literal
  timestamp: { ref: outcome.completedAt },         # from path
})
```

The SDK desugars `{ ...o.value, decision: o.value.choice }` to a `merge` of `value` (the spread) with a `construct({ decision: { ref: 'value.choice' } })` (the override).

### Array map and reduce

Out of scope for v1. For per-element transforms over an array, fan out via `Map` (a real node with sub-Runs); for shape changes that need per-element logic, write a Task. The transform DSL stays compositional at the record level, not the array-element level.

For `Map.extract`, the result must be array-shaped — checked at bind time against the upstream output schema.

## PredicateExpr — boolean expressions over `Outcome<O>`

Edge `when` predicates.

```
expr  ::= "and(" expr "," expr ")"
        | "or(" expr "," expr ")"
        | "not(" expr ")"
        | "eq(" path "," value ")"
        | "ne(" path "," value ")"
        | "lt(" path "," value ")" | "gt" | "lte" | "gte"
        | "in(" path "," "[" value ("," value)* "]" ")"
        | "exists(" path ")"
        | "matches(" path "," regex ")"
        # array operations
        | "any(" path "," expr ")"                # array → bool: some element matches
        | "all(" path "," expr ")"                # array → bool: every element matches
        # numeric over array via length() in TransformExpr:
        # eq(length(value.findings), lit(0))      # array empty
path  ::= "outcome.tag" | "value." rest | "error." rest | "element." rest
```

The `any` / `all` predicates take a sub-predicate over each array element; within the sub-predicate, `element.<path>` refers to the element being tested:

```ts
// "Any finding is high or critical"
any(value.findings, in(element.severity, ['high', 'critical']))

// "All commits have a non-empty message"
all(value.commits, exists(element.message))

// "Findings array is empty" — combine length() (TransformExpr) with eq() (PredicateExpr)
eq(length(value.findings), lit(0))
```

Paths into `Outcome<O>`:
- `outcome.tag` — the discriminator (`ok` | `err` | `aborted`)
- `value.<path>` — typed payload for `ok` outcomes
- `error.<path>` — typed error body for `err` outcomes (e.g., `error.exitCode` for Task)

## BuiltinRef — named runtime function

Escape hatch for cases where the DSLs fall short. Authors reference a runtime-provided builtin by name; the runtime resolves at bind.

```
ref ::= { "kind": "ref", "ref": identifier }
```

Used in:
- Edge predicates / transforms when the DSL doesn't suffice
- `Reduce { kind: 'function' }` for the reducer choice

Builtin categories shipped at v1:

| Category | Builtins |
|---|---|
| Reducer builtins | `concat`, `majority_vote`, `json_merge`, `dedup_rank` |
| Edge predicates | (small fixed set; expand as needed by real workflow drift) |

Not user-extensible at the IR level — extensions register *tools*, not builtins. Builtin behavior is a stable contract; changes get new names (`concat_v2`).

## Canonical JSON shapes

Each expression type serializes to a stable JSON shape. The canonical form is what `workflow_sha` hashes; the SDK emits this shape from desugared arrows / strings / builder calls.

```jsonc
// TemplateExpr
{ "template": "Task: ${input.task}\nFiles: ${input.files | join(', ')}" }

// PathExpr (path-only access)
{ "path": "input.files[0].name" }

// TransformExpr
{ "op": "pick",    "paths": ["input.task", "input.files"] }
{ "op": "set",     "path":  "decision", "value": { "ref": "value.choice" } }
{ "op": "set",     "path":  "approved", "value": { "lit": true } }
{ "op": "construct", "fields": {
    "verdict":   { "ref": "value.verdict" },
    "reviewer":  { "lit": "sonnet" }
} }
{ "op": "merge",   "left": <transform>, "right": <transform> }

// PredicateExpr
{ "op": "eq",       "path": "value.verdict",       "value": { "lit": "approve" } }
{ "op": "and",      "lhs":  <predicate>,           "rhs":   <predicate> }
{ "op": "exists",   "path": "value.optional" }
{ "op": "matches",  "path": "value.text",          "regex": "^[A-Z]+$" }
{ "op": "in",       "path": "value.severity",      "values": ["high", "critical"] }

// BuiltinRef
{ "kind": "ref", "ref": "majority_vote" }
```

Canonicalization rules for `workflow_sha`:

- Field order within objects: alphabetical (per the canonical-JSON pinning in `docs/proposals/json-ir-canonical.md`).
- Whitespace normalised to the canonical form before hashing.
- Numbers: integer form when integral; no trailing zeros in decimals.
- Strings: UTF-8, no escapes beyond JSON-required.
- Nested expressions hashed recursively as part of the parent IR.

The IR-validator validates each expression node against its op schema at bind time. Unknown ops are rejected.

## SDK desugaring

The TS-builder accepts author-friendly forms and emits the expression-language IR at `.compile()`:

| Author writes | IR emits |
|---|---|
| `'Task: ${input.task}'` (string with placeholders) | TemplateExpr |
| `(o) => o.value.verdict === 'approve'` | PredicateExpr (`eq(value.verdict, 'approve')`) |
| `(o) => o.value` | PathExpr (`value`) |
| `(o) => ({ ...o.value, decision: o.value.choice })` | TransformExpr (`merge(value, set(decision, value.choice))`) |
| Imported builtin (e.g. `majority_vote` for a reducer) | BuiltinRef (`{ kind: 'ref', ref: 'majority_vote' }`) |

Rejected at `.compile()` time:
- Multi-statement arrows
- Closures over external variables
- Method calls outside the filter registry
- Async expressions
- Any non-deterministic operation (`Date.now()`, `Math.random()`)

Error messages point at the alternatives: split edges, pre-compute via a Task, use a builtin ref.

## What this constraint buys

- **IR portability** — pure JSON, no embedded code, no sandboxing required at runtime.
- **Hash stability** — `workflow_sha` doesn't depend on whitespace, formatting, or TS version.
- **Replay determinism** — expressions are pure functions of their input; no side effects, no clocks, no IO.
- **Cross-language emit** — a Python or Go client could emit the same IR if/when needed.
- **Static analysis on a decidable subset** — predicate completeness/disjointness are checkable over the small subset (`eq` / `ne` / `in` / `exists` over enum-typed fields with finite literal sets). Outside the subset (regex, inequality, BuiltinRef, array predicates) the checks are undecidable and the validator emits best-effort warnings — *not* errors. The runtime routes correctly via source-order tie-break regardless. See [`laws.md`](laws.md) and [`types.md`](types.md#tier-2--ir-validator-decidable-cases-only-pre-run) for the precise scope.

What it costs: rich pre-prompt logic (conditional sections, async fetches) can't live in the LLM node's `prompt`. Authors move that work to upstream `Task` nodes. Simple object/array shape projections stay in-edge via `construct` and `map` / `filter` / `count`. The constraint forces cleaner, more linear workflows.

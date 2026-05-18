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
            | "set(" path "," value ")"
            | "rename(" "{" identifier ":" identifier ("," identifier ":" identifier)* "}" ")"
            | "merge(" transform "," transform ")"
            | "take(" path "," integer ")"        # first N elements
            | "drop(" path "," integer ")"        # skip first N
            | "json(" path ")"                    # serialize value to JSON string
value     ::= STRING | NUMBER | BOOL | NULL
```

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
path  ::= "outcome.tag" | "value." rest | "error." rest
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
- **Static analysis** — predicate completeness, disjointness, and schema compatibility all decidable on the AST.

What it costs: rich pre-prompt logic (conditional sections, loops, async fetches) can't live in the LLM node's `prompt`. Authors move that work to upstream `Task` nodes. The constraint forces cleaner, more linear workflows.

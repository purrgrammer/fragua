# Authoring a workflow

A workflow is a single YAML file: a small state machine that wires LLM steps,
shell tools, and human approval gates into a deterministic, replayable pipeline.
You declare the **steps** and how they connect; the engine drives them.

This is the human on-ramp — enough to author and run a minimal workflow from
scratch. For the deep reference (loops, goal gates, routing patterns, data-flow
channels, the full attribute and validator-code tables) read
[`.agents/skills/workflows/SKILL.md`](../.agents/skills/workflows/SKILL.md); for
the primitives and invariants read [`SPEC.md`](./SPEC.md) §3–§4.

---

## A minimal workflow, annotated

```yaml
name: hello-world                 # bare-name identity → `fragua run hello-world`
goal: Draft a greeting, polish it, and let a human approve before printing.

inputs:                           # typed run inputs, supplied with --input name=value
  name:
    type: string                  # string | boolean | number | choice (choice needs options:)
    required: true                # a required input with no value → enqueue rejected
    description: Who to greet.

defaults:                         # applied to every llm step that omits the key
  provider: anthropic
  model: claude-sonnet-4-6

steps:                            # the FIRST step declared is the entry point
  draft:
    type: llm                     # llm (default) | tool | human | exit
    prompt: |
      Write a short, friendly one-line greeting for ${{ inputs.name }}.
    outputs:                      # this step emits a typed value other steps can read
      greeting:
        type: string
    next: refine                  # success successor — flow is always explicit

  refine:
    type: llm
    prompt: |
      Polish this greeting into a single warm sentence:
      ${{ outputs.draft.greeting }}     # ← consumes draft's typed output
    outputs:
      final:
        type: string
    next: approve

  approve:
    type: human                   # pauses the run; operator picks one named route
    text: |
      Send this greeting?
      ${{ outputs.refine.final }}
    routes:
      send: { to: announce, label: "Send it" }   # proceed
      redo: { to: draft, label: "Try again" }    # send back upstream (a redo loop)

  announce:
    type: llm
    prompt: |
      Print the approved greeting verbatim:
      ${{ outputs.refine.final }}
    next: exit                    # terminate by routing to the reserved `exit` sink
```

What to notice:

- **Every step names its success successor** via `next:` (or `on:` / `routes:`).
  There is no fall-through to the next-declared step — a step with no successor
  is a validation error. Finish a branch with `next: exit`.
- **`exit` and `start` are reserved.** The first step becomes the entry; you
  never declare `start`. Terminate by routing to `exit`; never declare a step
  named `exit`.
- **A `human` step** pauses the run and renders one button per route. "Send
  back / try again" is just a route pointing at an upstream step.

---

## The two substitution tokens

Only two tokens are substituted in `prompt:`, `text:`, and tool `run:` strings.
A bare `$name` or `${…}` is **literal text** — it is never substituted.
(AGENTS.md ground rule 13 is the source of truth for the exact grammar.)

- **`${{ inputs.<name> }}`** — a typed run input declared under `inputs:`.
  Supplied as `--input <name>=<value>` (repeatable), or from the input's
  `default:`. Referencing an input you didn't declare is a validation error
  (E030).

- **`${{ outputs.<producer>.<field>[.<sub>] }}`** — a typed value emitted by an
  upstream `llm` step's `outputs:`. A scalar interpolates as its value; a
  record or array interpolates as JSON. Only `llm` steps *produce* outputs;
  `tool` and `human` steps consume but never produce, and `outputs:` is mutually
  exclusive with `routes:`.

**Reads fail closed.** Referencing a field the producer never populated on the
path actually taken *fails the consuming step* — it is never a silent `""`. The
validator catches the static cases up front (E035 for a broken reference; W015
when the producer might not run on every path to the consumer).

---

## Validate and run

```sh
fragua validate path/to/hello-world.yaml          # parse + lint, no execution
fragua run      hello-world --input name=Ada       # upload + enqueue + stream events
```

`fragua validate` is the fast loop — fix every error and take warnings
seriously. `fragua run` resolves a bare name against `~/.fragua/workflows/`,
then `<cwd>/.fragua/workflows/`; drop the file in either directory (or pass a
path) to make it runnable.

When a *running* workflow misbehaves (steer / pause / resume / diagnose), that's
the [`operate`](../.agents/skills/operate/SKILL.md) skill's territory, not this
guide.

---

## hello-world.yaml — copy, save, run

Save this verbatim as `hello-world.yaml`, then
`fragua validate hello-world.yaml` and
`fragua run hello-world --input name=Ada`.

```yaml
name: hello-world
goal: Draft a greeting, polish it, and let a human approve before printing.

inputs:
  name:
    type: string
    required: true
    description: Who to greet.

defaults:
  provider: anthropic
  model: claude-sonnet-4-6

steps:
  draft:
    type: llm
    prompt: |
      Write a short, friendly one-line greeting for ${{ inputs.name }}.
    outputs:
      greeting:
        type: string
    next: refine

  refine:
    type: llm
    prompt: |
      Polish this greeting into a single warm sentence:
      ${{ outputs.draft.greeting }}
    outputs:
      final:
        type: string
    next: approve

  approve:
    type: human
    text: |
      Send this greeting?
      ${{ outputs.refine.final }}
    routes:
      send: { to: announce, label: "Send it" }
      redo: { to: draft, label: "Try again" }

  announce:
    type: llm
    prompt: |
      Print the approved greeting verbatim:
      ${{ outputs.refine.final }}
    next: exit
```

---

## Where to go next

- **Loops, goal gates, routing, threads, tool steps, the full attribute and
  validator-code tables** → [`.agents/skills/workflows/SKILL.md`](../.agents/skills/workflows/SKILL.md).
- **Primitives and invariants** → [`SPEC.md`](./SPEC.md) §3–§4.
- **Where files land at run time** (worktree lifecycle, accept/discard) →
  [`execution-model.md`](./execution-model.md).
- **Shipped production examples** → `.fragua/workflows/` (`work.yaml`,
  `review.yaml`, …) — full-rigor references, not starting points.

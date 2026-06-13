# fragua

> Cuando los niños en la escuela \
> estudiaban pa' el mañana, \
> mi niñez era la fragua: \
> yunque, clavo y alcayata.
>
> — Camarón de la Isla

durable, portable execution for engineering workflows. drive LLM agents with a deterministic control plane, humans in the loop, full event-log audit, and a live operator dashboard. runs on your laptop and on CI.

built on one bet: the **control plane** is worth making deterministic even when the LLM bodies are not. two invariants carry it:

- **all durable writes for a run linearize through one committer.** fan-out branches execute *concurrently*, but their commits *serialize* — concurrent execution never means concurrent commits. the committer assigns one monotonic order to every fact, so a recorded run replays by folding that one linear log, not by re-running the model. durability is turn-grained: a turn recorded before a crash never re-runs, but an LLM call still in flight when the process dies re-executes on resume — the fold is deterministic; forward re-execution is not.
- **operator actions are intents.** pause, steer, resume, budget raises — always-appendable, conflict-free writes (no OCC) that the executor folds into the next dispatch. that's what makes steering a live LLM run mid-flight possible: the in-flight handler unwinds, the next dispatch sees your text, the run never dies.

the rest follows:

- declarative YAML workflows
- survives crashes, provider outages, and transient errors
- provider-agnostic
- models à la carte per step
- concurrent fan-out with deterministic replay
- cost-control
- superb observability
- a run is a portable artifact

## what you get

- **workflows are text.** plain YAML. diff them, version them, code-review them. no DSL.
- **survives crashes & provider hiccups.** intent/fact split with OCC; transient errors (408/429/5xx/network) auto-retry; recoverable failures (budget caps, loop/goal ceilings, watchdog timeouts, engine incompatibility) pause instead of dying. raise the cap, resume. daemon restart picks up mid-flight runs.
- **same workflow, any provider.** per-step `provider` / `model` overrides, pre-flighted against pi-ai's registry — bad combos fail in milliseconds, not after 30 retries.
- **operator surface, not an afterthought.** live web UI on `:6767`: per-run + global SSE, run-scoped file tree + git-aware diff, transcripts, cost panels, steering + HITL — all intents on the event log, appendable daemon up or down.
- **fan out when it pays.** a `parallel` step forks read-only branches that run concurrently and converge on a single `wait_all` join; typed `outputs:` carry each branch's result forward. every branch commits through the run's one committer — one shared abort, one interleaved log, replay by fold. a topology change, not a second scheduler.
  > **parallel branches must be read-only `llm` steps.** each branch node has to be `type: llm` and may not reach a write-class tool — `bash`, `write`, or `edit` (scope with `allowed-tools` / `denied-tools`). branches share the worktree read-only and only *produce* results; the validator rejects a writing branch (E042). all durable commits serialize through the run's single committer.
- **schedules built in.** fire on a fixed interval (`30m`…`7d`) with skip / queue / concurrent overlap, late-fire catch-up, per-schedule run history.
- **a run is a portable artifact.** the event log, messages, canonical workflow IR and a git-bundle of the worktree snapshots together are self-contained and portable. share them, replay them, debug them on another machine.

## prerequisites

- **git** — required. every run executes in an isolated git worktree under `.fragua/worktrees/<run-id>/`, snapshots land on `refs/fragua/*`, and diff / accept / discard are git operations; outside a git repo, `fragua init` warns and worktree isolation — most of the value proposition — is unavailable.
- **a provider API key** — Anthropic, OpenAI, or any provider [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) supports. `fragua providers add` stores it.
- **Bun ≥ 1.2** — required to build from source (the from-source path below); the release binaries are self-contained.
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — *optional.* Only needed for PR-number targets: the `review` / `pr_review` workflows call `gh pr checkout` / `gh pr view` when you pass `target="PR <n>"`. Commitish, path, and branch targets need only git.
- **Windows** — no native build; run under **WSL2** (Bun + git inside the Linux distro work as on any Linux host).

## install

### release binary

every [release](https://github.com/purrgrammer/fragua/releases) publishes self-contained binaries for **linux x64/arm64 and macOS x64/arm64** (no Windows build today), each in a full flavor (`fragua-<target>`, web UI embedded) and a headless one (`fragua-headless-<target>`, ~20% smaller, no `harness`/`serve` UI — what CI installs). a `SHA256SUMS` file and Sigstore build-provenance attestations cover every asset.

```sh
gh release download --repo purrgrammer/fragua \
  --pattern "fragua-bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')" \
  --output fragua
chmod +x fragua && mv fragua ~/.local/bin/   # anywhere on PATH
fragua --version
```

### from source

No published release for your target, or you'd rather not trust a prebuilt binary? Build it yourself — this is a first-class install path, not contributor-only. It needs **Bun ≥ 1.2** and a clone of this repo:

```sh
bun install
bun run build:bin              # compiles dist/fragua (web UI embedded)
export PATH="$PWD/dist:$PATH"   # or symlink dist/fragua into /usr/local/bin
fragua --version
```

> hacking on fragua itself? skip the build — `bun run fragua <args…>` hits the same entry point. `fragua` and `bun run fragua` are interchangeable.

## quickstart — adopt fragua in your project

three steps from zero to a first run, on **whatever one provider you hold a key for**:

```sh
# 1. install (above), add a key, start the harness
fragua providers add            # pick ANY provider — Anthropic, OpenAI, Gemini, … — paste a key
fragua harness                  # daemon + web UI on :6767, Ctrl-C to stop

# 2. initialise your repo (separate terminal) and copy in the starter workflows
cd ~/code/acme-webshop
fragua init                     # writes .fragua/config.yaml + an empty .fragua/workflows/
curl -fsSL -o .fragua/workflows/hello-world.yaml \
  https://raw.githubusercontent.com/purrgrammer/fragua/main/.fragua/workflows/hello-world.yaml

# 3. run the provider-neutral smoke test
fragua run hello-world --input name="Ada"
```

`hello-world` is the **same workflow, any provider** promise made literal: it pins no `provider:` / `model:`, so it runs on whatever credential you added in step 1 — no YAML editing to switch providers. The run greets `Ada`, writes `hello.txt` into its worktree, and exits; **cost:** a fraction of its `budget: 1.00` hard cap.

**switching / pinning a provider.** A workflow that omits `provider:` resolves the provider/model in this order — first match wins:

1. a `defaults:` block in the workflow file itself;
2. `defaults:` in `~/.fragua/config.yaml` (applies to every workflow that omits one);
3. autodetect — the first provider you hold a credential for.

So to point every provider-neutral workflow at, say, OpenAI without touching any `.yaml`, set the config defaults:

```yaml
# ~/.fragua/config.yaml
defaults:
  provider: openai
  model: gpt-5
```

> `--input` binds typed run inputs (`${{ inputs.name }}` in prompts) — it does **not** change the provider. Provider selection is the config-`defaults:` / workflow-`defaults:` surface above.

once the smoke test passes, run a **portable code review** over your last commit:

```sh
curl -fsSL -o .fragua/workflows/review.yaml \
  https://raw.githubusercontent.com/purrgrammer/fragua/main/.fragua/workflows/review.yaml
fragua run review --input target="HEAD~1..HEAD"
```

`review` assumes nothing about your project beyond git (and `gh` for PR targets), but it **does** pin a provider in its `defaults:` — edit that block (or override via the config defaults above) to run it on your provider. the run streams to your terminal (`fragua runs tail <id>` re-attaches later); it scales the review to the diff, writes `review.md` into the run's worktree, then pauses at a signoff gate. **cost:** a one-commit diff routes through the cheap tier — typically well under $1; the workflow's `budget: 12.00` is a hard cap at which the run pauses for you to raise it or stop, never overspending silently.

**answer the signoff gate.** The run is now `paused_human` — it won't proceed until you respond. Find its id with `fragua runs ls` (or `fragua runs inbox`, which lists only runs awaiting a decision). The `review` gate offers three routes: **`approve`** (post the review and approve the PR), **`feedback`** (post it as PR feedback — request-changes if there's a Critical/High defect, else a comment), and **`accept`** (keep the review local, no PR action). Answer from the terminal — `fragua runs respond <id> approve` (or `feedback` / `accept`) — or click the route in the web UI inbox on `:6767`. The `approve` / `feedback` routes only post when the target is a real PR; for a local `HEAD~1..HEAD` diff they no-op and the run completes. The deliverable — `review.md` — lives in the run's worktree at `.fragua/worktrees/<run_id>/review.md`; `fragua runs accept <id>` lands the worktree's commits onto your branch.

run discovery is automatic (via the global DB), so `fragua run` works from any directory. point it at a `.yaml` path or a bare name resolved under `~/.fragua/workflows/` then `<cwd>/.fragua/workflows/`. inputs: `-i name=value` (repeatable, `@path` reads a file, `@-` reads stdin). `--title` names the run, `--no-follow` prints the id and exits.

## Install in CI

Pin the action to a release tag in consumer repos:

```yaml
- uses: purrgrammer/fragua/.github/actions/setup-fragua@v0.7.0
```

**[docs/CI.md](docs/CI.md)** is the CI guide — GitHub Actions setup, provider credentials, passing secrets to tool steps (`--allow-env`), and exporting/importing run bundles. [`.github/actions/setup-fragua/README.md`](.github/actions/setup-fragua/README.md) documents the action's inputs.

## workflows

ships under `.fragua/workflows/` — run from the repo, or copy into `~/.fragua/workflows/` to use anywhere. **`hello-world`, `review`, and `pr_review` are portable starters**: `hello-world` pins no provider and needs no project at all; `review` / `pr_review` assume nothing but git and work on any repo (`gh` is needed only for PR-number targets — always for `pr_review`, only for `target="PR <n>"` on `review`). the rest are wired to fragua's own scripts, conventions, and docs — run them here, or read them as authoring references.

each `budget:` is a run-level hard cap, not the typical cost — small inputs spend a fraction of it. at the cap the run pauses for the operator (raise or stop), except where noted.

| workflow | what it does | portability | spend |
|---|---|---|---|
| `hello-world` | greet the operator and write `hello.txt` — the zero-dependency smoke test. | **portable — pins no provider; runs on any configured key** | `budget: 1.00` cap |
| `review`  | scope a PR / diff → structured review, with a gated apply tail. | **portable — works on any repo** (PR-number targets need `gh`) | `budget: 12.00` cap |
| `pr_review` | unattended PR review for CI — posts the verdict back to the PR. | **portable — works on any repo** (needs `gh` + `GH_TOKEN`) | `budget: 21.00` cap |
| `work`    | triage → (plan / reproduce) → implement → review → CI. leaves the change in the worktree to accept. | fragua-internal (`bun run ci`, repo conventions) | **no default budget — set one**; defaults to a frontier model |
| `analyze` | cost / token / latency analytics over recorded runs. | fragua-internal (repo scripts) | `budget: 5.00` cap |
| `dependencies` | bump outdated dependency pins, keep typecheck + CI green. | fragua-internal (`bun run typecheck` / `bun run ci`) | `budget: 6.00` cap |
| `drift`   | audit fragua's own arch / spec / skill docs against the code. | fragua-internal | `budget: 10.00` cap, **stops** at the cap |
| `propose` | draft a design proposal through a five-lens adversarial panel. | fragua-internal (SPEC / proposals corpus) | `budget: 40.00` cap |

author your own; `fragua validate <file>` parses + lints before you run. the `workflows` skill is the authoring guide.

## skills

domain context loaded on demand by the agents a workflow runs. live under `.agents/skills/` (symlinked into `.claude/skills/`).

| skill | loaded when you're… |
|---|---|
| `workflows`  | authoring or editing a workflow YAML |
| `operate`    | driving **or debugging** a run — enqueue, tail, steer, HITL, land, and the failure-mode forensics |
| `backend`    | touching `packages/{server,store,core,agent}` |
| `frontend`   | touching the React dashboard under `packages/web/src` |
| `design`     | touching styles, theme tokens, or layout in `packages/web` |

## commands

The essentials below; the **[full CLI reference](docs/cli.md)** has every verb, flag, and the exit-code taxonomy.

```sh
fragua providers add            # add a provider credential (--custom for OpenAI-compatible)
fragua harness                  # daemon + HTTP on :6767 (Ctrl-C to stop)

fragua run <workflow> -i task="…"   # save + enqueue + follow (--no-follow to detach)
fragua runs inbox                   # runs needing an operator decision
fragua runs status <id>             # one run: lifecycle + outcome + the why
fragua runs tail   <id>             # follow an existing run's event log
fragua runs respond <id> [route]    # answer a HITL gate
fragua runs accept  <id>            # land a finished run's commits onto your branch

fragua ci <workflow>            # one-shot: run to terminal, exit code = outcome (CI)
fragua schedule add <wf> --every 1h
fragua validate <workflow.yaml>
```

A followed run's exit code reflects its outcome — `0` completed, non-zero by halt / pause / quarantine reason (the [CLI reference](docs/cli.md#exit-codes) has the full map). The CLI is a direct store-client: these work from any directory against `~/.fragua/fragua.db`, daemon up or down.

## status & docs

- **[STATUS.md](STATUS.md)** — what's working today, what's not yet
- **[docs/cli.md](docs/cli.md)** — the full CLI reference + exit-code taxonomy
- **[docs/CI.md](docs/CI.md)** — running fragua in CI: setup, credentials, `--allow-env`, bundles
- **[docs/SPEC.md](docs/SPEC.md)** — what fragua is
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — schema, invariants, property matrix
- **[docs/handler-contract.md](docs/handler-contract.md)** — writing handlers
- **[docs/providers.md](docs/providers.md)** — providers + credential setup
- **[AGENTS.md](AGENTS.md)** — conventions for agents (and humans)

## stack

Bun ≥ 1.2 · TypeScript strict · SQLite (WAL + STRICT) · Hono · React 18 + Vite 5 + Tailwind 4. LLM layer is [`pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) (15+ providers) + [`pi-agent-core`](https://github.com/badlogic/pi-mono/tree/main/packages/agent). store, daemon, server, and handler contract are fragua's own.

## license

MIT.

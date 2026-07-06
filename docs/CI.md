# fragua in CI

Run fragua workflows in CI with `fragua ci <workflow>` — a one-shot command
that embeds the executor over an ephemeral store, drives the run to a stop
state, and exits with a code that reflects the outcome (`0` completed,
non-zero by halt/pause/quarantine reason). A fragua run gates a job the same
way a test suite does. See the [CLI reference](cli.md#one-shot-ci--fragua-ci-workflow)
for the verb and the [exit-code map](cli.md#exit-codes).

Working examples in this repo: [`.github/workflows/pr-review.yml`](../.github/workflows/pr-review.yml)
(read-only review of an untrusted PR diff) and
[`.github/workflows/drift.yml`](../.github/workflows/drift.yml) (scheduled
doc-drift audit that opens a PR).

## GitHub Actions setup

The [`setup-fragua`](../.github/actions/setup-fragua/README.md) composite
action downloads the release binary for the runner's OS/arch, verifies it
against the release's `SHA256SUMS`, and puts it on `PATH`.

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # full history if the workflow diffs against base
      - uses: purrgrammer/fragua/.github/actions/setup-fragua@v0.9.0 # ← pin the tag
      - run: fragua ci my-workflow --input task="…"
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

- **Pin `setup-fragua` to a release tag — do not float `latest`.** The engine
  your team reviewed should be the engine CI runs; upgrade by bumping the tag
  in a reviewed commit.
- **`actions/checkout` must run first.** `fragua ci` provisions a git worktree
  per run under the checkout, so it needs a git repository to work in.
- The workflow name resolves against `~/.fragua/workflows/<name>.yaml`, then
  `.fragua/workflows/<name>.yaml` in the checkout — same resolution as the
  local CLI. A path (`./path/to/wf.yaml`) also works.
- `setup-fragua` installs the smaller **headless** binary by default (no
  `harness`/`serve` web UI — all `fragua ci` needs). Pass `web: true` for the
  full binary.
- Scope job `permissions:` to the workflow's trust posture: a workflow that
  runs LLM tool-calls over untrusted input (a PR diff) should be read-only
  (`contents: read`); only a workflow that pushes branches or opens PRs needs
  `contents: write` / `pull-requests: write`.

## Provider credentials

`fragua ci` reads provider credentials from the environment at startup — there
is no `fragua providers add` step in CI. Set the provider's conventional env
var in the job/step `env` and it is seeded automatically; `fragua ci` prints
`creds seeded for <provider>` so you can confirm which one resolved. Every
provider pi-ai knows an env var for works the same way (`OPENAI_API_KEY`,
`GEMINI_API_KEY`, …) — see [providers.md](providers.md).

```yaml
- run: fragua ci my-workflow
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Anthropic OAuth token (Claude subscription).** Use a long-lived token from
`claude setup-token` instead of an API key. fragua reads it from
**`ANTHROPIC_OAUTH_TOKEN`** (not `CLAUDE_CODE_OAUTH_TOKEN`); name the repo
secret anything and map it:

```yaml
- run: fragua ci my-workflow
  env:
    ANTHROPIC_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

`ANTHROPIC_OAUTH_TOKEN` takes precedence over `ANTHROPIC_API_KEY` when both
are set; fragua detects the `sk-ant-oat…` shape and switches to Bearer auth
with Claude-Code identity headers. An OAuth token draws on the associated
Claude subscription rather than API billing — unattended CI use is subject to
Anthropic's usage terms.

`--provider <id>` / `--model <id>` override the workflow's defaults for the
whole run.

## Secrets for tool steps — `--allow-env`

Provider credentials are read by fragua itself. Everything else a workflow's
`tool` steps need (e.g. `GH_TOKEN` for `gh`) goes through `--allow-env`,
because `fragua ci` **strips secret-named env vars from tool subprocesses** by
default: any var whose name ends in `_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`,
`_CREDENTIAL`, `_PASS`, `_AUTH`, or `_PASSPHRASE`, plus every known
provider-credential var.

```yaml
- run: fragua ci pr_review --input pr=${{ github.event.pull_request.number }} --allow-env GH_TOKEN
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    GH_TOKEN: ${{ github.token }}
```

- `--allow-env NAME` exempts the var from the strip **only** — allow ≠
  declassify. The value is still captured as a scrub needle and redacted from
  the exported bundle. Repeat the flag or comma-separate for multiple names.
- Provider credentials are **refused**: `--allow-env ANTHROPIC_API_KEY` (or
  any `*_API_KEY`, or `ANTHROPIC_OAUTH_TOKEN`) exits with a usage error. A
  provider key must never reach a tool subprocess.
- The strip applies at spawn time against the live env, so a secret-named var
  set mid-run is still stripped.

## Run bundles — export and import

`fragua ci --export <path>` writes a portable, **secret-free** `.fragua`
bundle: the run's event log, transcript, artifacts, and workflow in one file
(`run_state` is re-derived on import). The export scrubs provider-credential
values, secret-named env values, and known credential patterns from events /
messages / artifacts, replacing them with `[REDACTED]` markers. If a live
secret value reached an un-scrubbable binary artifact, the job fails with exit
`80` — the perimeter-leak alarm — so the exit code itself is the fail-closed
gate.

The bundle is written even when the run halts or pauses, so pair the upload
with `if: always()`:

```yaml
- run: fragua ci my-workflow --export "$RUNNER_TEMP/run.fragua"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: fragua-run
    path: ${{ runner.temp }}/run.fragua
```

Download the artifact and inspect locally:

```sh
fragua show run.fragua          # validate + summarize — no store needed
fragua import run.fragua        # merge into a store (default: the harness store); the run is inert
fragua runs status|events|steps|messages <run-id>
```

`fragua runs export <id> --to <file.fragua>` produces the same bundle from any
store, so runs move between machines in either direction.

> `--db <path>` pins the raw CI store instead of a temp dir. It is a **local
> inspection artifact only**: the credential table is dropped, but the event
> log and transcript are NOT scrubbed and can hold secrets verbatim. Never
> upload it — the bundle is the safe egress.

## Exit codes

The full status+reason → code map lives in the
[CLI reference](cli.md#exit-codes). The short version for pipelines: `0`
completed; `1` couldn't run at all; `10`–`17` halted; `30`–`39` paused
(needs an operator — CI has no responder); `50`–`51` quarantined; `60`
waiting on human input; `80` live secret in the exported bundle; `130`
cancelled.

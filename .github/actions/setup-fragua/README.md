# setup-fragua

Download the [`fragua`](https://github.com/purrgrammer/fragua) binary for the
runner's OS/arch and put it on `PATH`. Pairs with `fragua ci <workflow>`, which
runs a workflow to completion and exits with a code that reflects the outcome
(0 completed, non-zero on halt/quarantine/pause) — so a fragua run gates a job
the same way a test suite does.

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: purrgrammer/fragua/.github/actions/setup-fragua@v0.1.0
  - run: fragua ci my-workflow
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`actions/checkout` must run first: `fragua ci` provisions a git worktree per run
under the checkout, so it needs a git repository to work in. The workflow name
resolves against `.fragua/workflows/<name>.yaml` in the checkout (and
`~/.fragua/workflows/`), exactly as the local CLI resolves it.

## Inputs

| Input | Default | Description |
|---|---|---|
| `version` | `latest` | Release tag to install (e.g. `v0.1.0`), or `latest` for the newest release. Pin it for reproducible CI. |
| `web` | `false` | `false` installs the smaller **headless** binary (no `harness`/`serve` UI — fine for `fragua ci`). `true` installs the full binary with the web UI. |
| `token` | `${{ github.token }}` | Token used to download the release asset. The default works when the consumer repo can read the fragua repo's releases. |

## Outputs

| Output | Description |
|---|---|
| `version` | The release tag that was installed. |
| `path` | Directory the binary was installed into (already added to `PATH`). |

## Credentials

`fragua ci` reads provider credentials from the environment at startup — there
is no `fragua providers add` step in CI. Set the conventional credential
variable for your provider in the job/step env and it's picked up
automatically. `fragua ci` prints `creds seeded for <provider>` so you can
confirm which one resolved.

### API key

```yaml
- run: fragua ci my-workflow
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Anthropic OAuth token (Claude subscription)

Use a long-lived OAuth token from `claude setup-token` instead of an API key.
The variable fragua reads is **`ANTHROPIC_OAUTH_TOKEN`** — not
`CLAUDE_CODE_OAUTH_TOKEN`, and not `ANTHROPIC_API_KEY`. Your repo secret can be
named anything; map it to that variable:

```yaml
- run: fragua ci my-workflow
  env:
    ANTHROPIC_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

Notes:

- `ANTHROPIC_OAUTH_TOKEN` takes precedence over `ANTHROPIC_API_KEY` if both are
  set. fragua detects the `sk-ant-oat…` token shape and switches to Bearer auth
  with Claude-Code identity headers.
- The env path supplies a bare access token with no refresh material. That's
  fine — `setup-token` tokens are long-lived; rotate the secret when one
  expires.
- An OAuth token draws on the associated Claude subscription rather than API
  billing. Using it in unattended CI is subject to Anthropic's usage terms.

## Keeping the run as an artifact

`fragua ci --db <path>` pins the run's SQLite store, which is a portable,
replayable record of the whole run — useful for post-mortems on a failed job:

```yaml
- run: fragua ci my-workflow --db "$RUNNER_TEMP/run.db"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: fragua-run-db
    path: ${{ runner.temp }}/run.db
```

## Supported runners

`bun-linux-x64` (GitHub-hosted `ubuntu-latest`), `bun-linux-arm64`,
`bun-darwin-arm64`, `bun-darwin-x64`. An unsupported `runner.os`/`runner.arch`
fails the step with a clear message.

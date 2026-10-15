# fragua — Security model

> **Authoritative** for what fragua defends against and what it does not. Companion to [`SPEC.md`](./SPEC.md) §1 (the local-first wager) and §5 (out of scope). Where another doc describes a guardrail, this file says what the guardrail is *for*.

## 1. Who the user is, and what that forecloses

One engineer, one machine, one store. The operator owns the repository, holds the provider credentials, reviews every workflow before it runs, and reviews every diff before it lands (`fragua runs accept`). There is no second tenant, no shared runner, no hosted control plane. SPEC §1 states the bet; this document states its security consequences.

The consequence is a short list of **trusted parties** and a short list of **defended boundaries**. Everything outside both lists is explicitly not defended, and the docs must never imply otherwise.

## 2. Assets

| Asset | Where it lives | Leaves the machine only via |
|---|---|---|
| Provider credentials and OAuth tokens | `provider_credentials`, `mcp_oauth` tables in `~/.fragua/fragua.db` | never (bundles exclude both tables) |
| The event log, transcripts, artifact blobs | `~/.fragua/fragua.db`, `<blobsDir>` | `fragua runs export` (text payloads scrubbed; binary blobs are not) |
| The operator's working tree and git history | the project directory | `accept` replays a run's commits onto the operator's HEAD |
| Anything else on the host filesystem and network | the host | a `bash` or `tool` step |

## 3. Trusted parties

1. **The operator**, and any process running as the operator on this host.
2. **The reviewed workflow library.** A workflow that reached the executor passed `fragua validate` and was committed or uploaded by the operator. The YAML is the trust boundary, not the shell it runs.
3. **The LLM provider**, for the content of its replies, within the budget and tool set the workflow declared.
4. **CI**, as a delegated execution context: an ephemeral job against a throwaway store, with secrets gated by the CI platform's own permissions. `fragua ci --allow-env NAME` is how a job names the variables a tool step may see.

Not trusted: a web page open in the operator's browser; a remote origin that resolved a hostname to this host; the content a model reads from disk or from an earlier step's output; a `.fragua` bundle received from someone else (import verifies before it writes, is inspect-only, and the run is inert).

## 4. Defended boundaries

Each row names the mechanism, the test that pins it, and what it does *not* cover.

| Boundary | Mechanism | Pinned by | Not covered |
|---|---|---|---|
| Browser → control plane | Same-origin gate on every route: `Origin` must be the bound origin or loopback; `Host` must be the bound authority; bodied requests must be `application/json`. The Vite dev origin is trusted only under `fragua serve --dev`. Loopback bind by default. | `packages/server/test/origin-gate.test.ts` | a process on the same host that speaks HTTP; a wide bind the operator chose |
| Shell → operator's secrets | Deny-by-default env: a `bash` or `tool` subprocess inherits only `PATH`, `HOME`, `TMPDIR`, `TERM`, `SHELL`, `USER`, `LANG`, `LC_*` plus the operator's `bash.env-passthrough` (harness) or `--allow-env` (CI) names. Provider-credential names are refused from both lists. Engine variables arrive through the engine, never by ambient prefix: run-scoped `FRAGUA_RUN_ID` on every exec, and per-step `FRAGUA_OUTPUT` through the explicit per-step env. | `packages/workspace/test/local-env.test.ts`, `packages/cli/test/ci.test.ts`, `packages/cli/test/daemon-env-deny-wiring.test.ts` | files on disk (`cat ~/.ssh/id_rsa` runs); the network (`curl` runs); `HOME`-based tool config such as `gh`'s token store |
| Agent `read`/`write`/`edit` → outside the worktree | Realpath jail: paths resolve under the run's cwd and the checked realpath is the one read or written (`readFileBytes` on the environment). | `packages/workspace/test/tools.test.ts`, `local-env.test.ts` | the `bash` command body, by design (see §5) |
| Model → model (prompt injection via data) | Every `${{ inputs.* }}` and `${{ outputs.* }}` value interpolated into an `llm` prompt or a `judge` state is wrapped in a content-derived delimiter (`<fragua_output_<sha256>>…</…>`); the system prompt tells the model the wrapped text is data. | `packages/core/test/engine/outputs-substitution.test.ts`, `packages/core/test/handler/judge.test.ts` | text the model reads from disk with `read`/`bash`; the prompts the workflow author wrote |
| Workflow data → `tool` `run:` shell | Every `${{ inputs.* }}` / `${{ outputs.* }}` value substituted into `run:` is escaped for the quoting context its token sits in (a POSIX quote-state scan): bare → single-quoted, inside `"…"` → backslash-escaped, inside `'…'` → quote-escaped without a wrap. A token after a backslash, in backticks, a `#` comment, a heredoc body, `$'…'` or `$((…))` fails the node closed; the validator rejects those and single-quoted tokens at save (E058). | `packages/core/test/engine/shell-quote.test.ts` (each value run through `/bin/sh -c`), `packages/core/test/engine/validator.test.ts` | a script that re-evaluates the value (`eval`, `sh -c "$v"`, `bash -c ${{ … }}`, bash `[[ $v -eq 1 ]]` / `let`); quotes nested inside `${x:-"…"}`; a `case` pattern's unbalanced `)` inside `$(…)` |
| Terminating tool calls | `route`, `emit_output`, and `abort` must be called in isolation; a batch with other tool calls fails the node non-retryably. Scans start after the hydrated prefix so a shared thread cannot inherit an upstream node's call. | `packages/agent/test/route-tool.test.ts`, `abort-tool.test.ts`, `emit-output.test.ts` | — |
| Credentials → bundles | `runs export` excludes `provider_credentials` and `mcp_oauth`; text payloads pass an Aho-Corasick scan for every stored credential and are redacted; a live hit sets `liveLiteralHit` and `fragua ci --export` exits 80. | `packages/store/test/scrub.test.ts`, `scrub-e2e.property.test.ts` | a credential embedded verbatim in a binary blob (export warns, does not scrub) |
| Bundle → store (import) | Every workflow source is re-hashed against its sha and its IR re-derived from source (the bundle's `ir.json` is never stored); an existing workflows row at that sha must agree. A run that exists locally without the import marker is refused; a re-import of an imported run must carry the stored event log as a strict prefix, and the projection and `next_seq` are re-derived over the merged log. | `packages/store/test/bundle-import-trust.test.ts` | event payload shapes beyond the envelope and genesis gates; a workflow source this build cannot parse is refused, not imported |
| Side effects across a crash | Pre-commit `fact.side_effect_intent` with a provider idempotency key; an orphan at startup quarantines the run for the operator. | `packages/daemon/test/matrix.property.test.ts` (P6, P7, P25) | a provider that ignores idempotency keys |
| Read endpoints | `GET` routes perform no writes (health no longer reaps; stale-lock reclamation runs in the harness supervisor and daemon startup). | `packages/server/test/health.test.ts`, `intent-plane-discipline.test.ts` | — |

## 5. Explicitly not defended

- **`bash` is arbitrary code execution on the host as the operator.** The three guardrails around it (env allow-list, a seven-pattern refuse-list for catastrophic commands, a `cd`-escape backstop) reduce accidents; none of them is containment. A workflow that runs `bash` can read any file the operator can read and reach any network the operator can reach. If that is unacceptable for a workflow, do not give it `bash` (`allowed-tools: [read, grep, find]` is enforced at both the tool registry and the environment proxy).
- **The git worktree is working-tree isolation, not security isolation.** It keeps a run's changes out of the operator's tree until `accept`; it shares the host, the network, and `HOME`.
- **A compromised process on the same host.** Anything running as the operator can open `~/.fragua/fragua.db` directly. The same-origin gate stops browsers, not processes.
- **No authentication on the HTTP API.** Loopback bind plus the origin gate is the whole story. A wider `--host` bind is the operator accepting network exposure; the gate then trusts the bound host literally.
- **Blob encryption at rest.** A reader of the database can read everything; single-user, by design.
- **The operator's own prompts and workflow YAML.** Validation catches shape errors, not intent.

## 6. Residual risks the operator should know

1. `gh`, `git`, `aws`, and similar CLIs read credentials from `HOME`-based config, which the env allow-list cannot hide. A workflow with `bash` can use them.
2. A model that reads a file containing instructions will see them as text; the delimiter wrap covers substituted values, not everything the model reads.
3. `export` scrubs text, not binary blobs. Rotate a credential that `liveLiteralHit` reports before sharing the bundle.
4. Nothing stops a workflow from `git push`ing from the worktree if the operator's credentials allow it; the review-before-run model is the control.

## 7. Reporting

Security issues go to the repository's private vulnerability reporting on GitHub. Include the fragua version (`fragua --version`), the workflow, and the run id if one exists.

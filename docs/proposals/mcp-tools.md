---
title: MCP tools — materialise MCP server tools as first-class fragua tools
status: implemented-experimental
maturity: experimental
last-reviewed: 2026-07-20
---

# MCP tools

> Status: MVP — env-var credentials, stdio + HTTP transport, step-level opt-in,
> native OAuth (`fragua mcp login` / `logout`). Progressive disclosure and
> server-state UI are deferred (see §7).

## What this is

Let an `llm` step opt into [Model Context Protocol](https://modelcontextprotocol.io)
servers. Their tools are **materialised as ordinary fragua tools** — the model
sees `mcp__<server>__<tool>` alongside `read` / `bash` / `edit` and calls them
the same way. fragua is the MCP *client*: it spawns the server, lists its tools,
forwards `callTool`, and returns the result to the LLM.

This is the same shape ernesto exposes (`mcpServers:` on a step), but where
ernesto delegates the MCP wire protocol to a host SDK (Claude Agent SDK /
Cursor), fragua drives pi-agent-core directly and owns its own `ToolRegistry`, so
it materialises the tools itself. That is strictly simpler for us: an MCP tool
becomes an entry in the tool list that pi-ai cannot distinguish from a built-in.

## Authoring surface

```yaml
steps:
  triage:
    type: llm
    mcp-servers: [github, linear]     # connect these servers for this step
    prompt: |
      Look at the open issues and file a summary.
```

Declaring a server in `mcp-servers` exposes **all** of its tools. `allowed-tools`
narrows the MCP set **only when it names specific `mcp__*` tools** — then only
those materialise; an `allowed-tools` that lists only core tools leaves the MCP
set untouched (you narrowed core, not MCP). `denied-tools` always subtracts. So:
declare a server to get all its tools; to pin a step to specific MCP tools (e.g.
read-only), also list those tool names in `allowed-tools` (names come from
`fragua mcp check`).

`mcp-servers` is valid on `llm` steps only — declaring it on a `tool` or
`human` step is a parse error (not silently ignored).

## Server configuration

Servers are declared in **`<cwd>/.mcp.json`** at the project root — the same
file and shape Claude Code (and other tools) read, so a repo already configured
for MCP works with fragua unchanged:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

- **Transport:** **stdio** (`command` + `args`) and **Streamable HTTP**
  (`{ "type": "http", "url": …, "headers": {…} }`). HTTP covers the remote
  servers most tools ship (GitHub, ClickUp, Slack). Static auth goes in
  `headers` (`"Authorization": "Bearer ${TOKEN}"`); OAuth is layered on
  separately (see Auth below). The legacy **SSE** transport is
  tolerated-but-skipped (deprecated; requesting one yields a clear message and
  the rest of the file still loads).

  ```json
  { "mcpServers": { "github": {
      "type": "http", "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_PAT}" } } } }
  ```
- **Secrets:** `${VAR}` in `command` / `args` / `env` / `url` / `headers` values
  is resolved against the project's `<cwd>/.env` then `.env.local` (local
  overrides base), overlaid by `process.env` (an exported var always wins). This
  is loaded per-resolve from the run's project dir, so a token in `.env.local`
  reaches a workflow run without exporting it or restarting the daemon, and it
  works for the compiled binary (not just `bun run`'s implicit dotenv).
  **If any referenced `${VAR}` is unset, the server is skipped with an error** —
  never a connection that hangs waiting on a half-configured server.
- **Scope:** project root only for the MVP. A user-level `~/.mcp.json` cascade
  (mirroring the config.yaml cascade) is a later addition.

## Connection lifecycle

**Lazy, per-step.** When an `llm` step with a non-empty `mcp-servers` runs, the
backend connects the requested servers, lists their tools, runs the step, and
tears the connections down when the step finishes. No connection survives across
steps in the MVP (a per-run pool is a later optimisation). Connect is bounded by
a timeout so a broken server can never hang the daemon; on connect failure or a
missing credential the server is **skipped** — its tools simply don't appear,
the failure is surfaced as an observability event, and the step still runs with
whatever tools did materialise.

Failure is never fatal to the run: a step that asked for a server it couldn't get
proceeds without those tools rather than halting.

**Exception — an MCP-only `allowed-tools`.** If `allowed-tools` names *only*
`mcp__*` tools (so no core tool is selected) and none of them materialise — every
declared server failed, or the named tools don't exist — the step **fails**
(non-retryable) rather than running with an empty toolset. This is deliberate: a
step pinned exclusively to MCP tools that all vanished would otherwise "succeed"
having done nothing, the silent-empty-toolset footgun. Give the step a core tool
(or a reachable server) if you want the never-fatal behaviour.

## Replay & determinism

Materialised MCP tools are marked `idempotent: false` / no
`idempotentOnReplay`, exactly like `bash`. On rehydrate after a daemon crash the
sanitiser will **not** silently re-issue an MCP call — it surfaces an error
result and lets the LLM decide. MCP calls replay from the transcript like any
other side-effecting tool; they are not re-executed. No store schema, reducer, or
event-taxonomy change is required (I1–I11 untouched).

## Where it lives

| Concern | Location |
|---|---|
| `mcp.json` load + `${VAR}` resolution | `packages/workspace/src/mcp/config.ts` |
| MCP client, tool materialisation, teardown | `packages/workspace/src/mcp/connector.ts` |
| `mcp_servers` on `NodeAttrs` | `packages/core/src/types/graph.ts` |
| `mcp-servers` parse (kebab→snake, string[]) | `packages/core/src/parser/yaml.ts` |
| Connect + append + dispose around the agent run | `packages/agent/src/backend.ts` |
| Wire the connector into the backend | `packages/cli/src/executor-deps.ts` |
| `fragua mcp ls` / `fragua mcp check` | `packages/cli/src/commands/mcp.ts` |

The connector is injected into `PiLlmBackend` as an optional dependency
(`mcpConnector`), parallel to `skills` / `summariser`. The backend appends the
materialised tools right after the `skill`-tool reconciliation, where the final
tool set is assembled, and disposes them in a `finally` wrapper around the run so
every exit path releases the connection.

## Naming

`mcp__<server>__<tool>` — double underscore, matching the Claude Agent SDK /
ernesto convention. It disambiguates the server/tool boundary when either
contains underscores (`mcp__github__create_issue`) and reads identically across
engines. Server and tool segments are slugified to `[a-z0-9_]`. Names are capped
at Anthropic's 128-char tool-name limit.

MCP tool `parameters` is the server's raw JSON-Schema `inputSchema`, passed
through unchanged: pi-ai's tool-argument validator has a plain-JSON-Schema
fallback (it only reaches for TypeBox compilation when the schema carries the
TypeBox `Kind` symbol), so no schema translation is needed.

## OAuth

> Status: shipped. `fragua mcp login <server>` / `logout <server>` drive the
> interactive flow; the daemon connector reads tokens headlessly. Static-header
> auth (above) covers token servers like GitHub; ClickUp and Slack are OAuth-only.

The MCP SDK drives the OAuth 2.1 flow itself — `StreamableHTTPClientTransport`
takes an `authProvider: OAuthClientProvider`. On connect it uses the stored
access token, silently refreshes an expired one via the refresh token, and only
falls back to an interactive authorization when there's no usable token. We
supply the provider (storage + the interactive callback) and split it across two
contexts so **the daemon never blocks on a browser** (the invariant set at the
start):

- **`fragua mcp login <server>`** (operator machine, interactive): resolves the
  http server from `.mcp.json`, spins a localhost redirect listener on a fixed
  port, opens the browser to the authorization URL, catches the `code`, calls
  `transport.finishAuth(code)`, and persists client registration + tokens.
- **Daemon run** (headless): the provider reads tokens from the store and the SDK
  refreshes silently; `redirectToAuthorization` is a no-op that throws, so a
  server with no valid token is **skipped** with "not logged in — run
  `fragua mcp login <server>`", never a hung startup.

**Token storage** mirrors `provider_credentials`: a new `mcp_oauth` store table
(plain, secret-bearing, excluded from run bundles) with its own
`mcp-oauth-queries.ts`, **keyed by server URL** (the service identity — one login
serves every project that references the same URL) holding the client
registration (`client_id`, optional `client_secret`) and the token set
(`access`, `refresh`, `expires_at`).

`.mcp.json` stays purely server *definitions* (transport / url / headers) —
**no OAuth client config lives in it**. Everything secret (client registration
+ tokens) lives in the store and is managed through `fragua mcp login`.

**Client registration — two paths, because the servers differ:**

- **Dynamic Client Registration (DCR)** — GitHub / ClickUp: `fragua mcp login
  <server>` with no client flags; the SDK auto-registers a public client (PKCE)
  and we persist the returned `client_id`.
- **Confidential client** — Slack requires a pre-registered app with
  `client_id` + `client_secret` and **forbids DCR**. The operator passes them to
  the login command: `fragua mcp login slack --client-id … --client-secret …`
  (or an interactive prompt), and they're stored in `mcp_oauth` alongside the
  tokens — never in `.mcp.json`. Confidential clients also need their **redirect
  URI pre-registered** in the provider's app config, so `fragua mcp login` uses a
  **fixed** callback URL (documented) rather than an ephemeral port.

**Selecting the auth mode:** an `http` server with a static `Authorization`
header uses the header (no OAuth); otherwise the connector attaches the
authProvider and the SDK negotiates auth (token → refresh → skip-if-absent).

**`fragua mcp` surface:** `login <server> [--client-id … --client-secret …]`
(interactive browser flow), `logout <server>` (drop stored client + tokens), and
`ls` shows a per-server auth state (`ready` / `login required` / `missing env`).

## Trust model — no untrusted-content envelope

MCP tool results are returned to the LLM verbatim, **not** wrapped in an
`[EXTERNAL CONTENT]` / untrusted-data envelope. This is a deliberate decision,
not an oversight: MCP servers are operator opt-in (declared in `.mcp.json`),
their output is treated like any first-party tool's, and an envelope on every
call adds system-prompt weight and output noise for a boundary the prompt can't
robustly enforce anyway.

> **Known limitation.** This does *not* neutralise indirect prompt injection: a
> trusted *server* can still relay attacker-authored *content* (a GitHub issue
> body, a Slack message) into a context that also holds `bash`/`edit`. Treat MCP
> tools as you would any tool that reads external text — scope `allowed-tools`,
> keep write-capable tools off steps that fetch untrusted content, and don't
> point MCP-enabled steps at attacker-controlled data you wouldn't paste into a
> prompt yourself. Revisit an envelope (or per-server trust flags) if the threat
> model tightens.

## Deferred (§7)

- **Server-state UI** — the web dashboard equivalent of `fragua mcp ls` + a
  login affordance.
- **Progressive disclosure** — a tool-index + on-demand fetch when a server
  exposes many tools, instead of materialising all of them.
- **Per-run connection pooling** — reuse one connection across a run's steps.
- **User-level `~/.mcp.json`** cascade.
- **SSE transport** — deprecated upstream; skipped, not planned.

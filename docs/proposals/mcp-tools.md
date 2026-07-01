# MCP tools

> Status: MVP — env-var credentials, stdio transport, step-level opt-in. OAuth,
> HTTP transport, progressive disclosure, and server-state UI are deferred (see
> §7).

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

`mcp-servers` is **additive**: declaring a server exposes *all* of its tools to
the step, on top of whatever `allowed-tools` selects. `denied-tools` can still
remove individual materialised tools by name (`mcp__github__delete_repo`). This
matches "materialise all tools, no progressive disclosure" — an author opts into
a *server*, not into each tool by name (MCP tool names are only known at connect
time, so an allowlist would be unauthorable).

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

- **Transport:** stdio only for the MVP (`command` + `args`). A shared `.mcp.json`
  may also contain HTTP/SSE entries (`{ "type": "http", "url": … }`); those are
  **tolerated but skipped** — the stdio servers still load, and requesting a
  remote one yields a clear "unsupported transport" message rather than breaking
  the whole file. HTTP/SSE transport itself is deferred.
- **Secrets:** `${VAR}` in `command` / `args` / `env` values is substituted from
  the daemon's `process.env`. **If any referenced `${VAR}` is unset, the server
  is skipped with an error** — never a connection that hangs waiting on a
  half-configured server. No `.env` file loading in the MVP; the operator
  exports vars before starting the harness.
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

## Deferred (§7)

- **OAuth** — servers needing a browser login are authorised ahead of time; the
  daemon reads stored tokens and never blocks startup on a login flow. Token
  storage parallels provider credentials. Until then, OAuth servers are simply
  skipped like any missing-credential server.
- **Server-state UI + `fragua mcp login`** — see live server status and log in.
- **HTTP/SSE transport.**
- **Progressive disclosure** — a tool-index + on-demand fetch when a server
  exposes many tools, instead of materialising all of them.
- **Per-run connection pooling** — reuse one connection across a run's steps.
- **User-level `~/.mcp.json`** cascade.

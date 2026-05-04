---
title: Extensions — custom tools
status: in-progress
maturity: designed
last-reviewed: 2026-05-04
---

# Extensions — custom tools

User-authored TypeScript registers LLM-callable tools. One factory
per file. Discovered from `~/.swarm/extensions/` (user) and
`<cwd>/.swarm/extensions/` (project). API mirrors
`@mariozechner/pi-coding-agent`'s `registerTool` shape verbatim — so
authors who already write pi extensions transfer 1:1.

This is the first half of the extensions surface. Hooks (with
feedback semantics) live in a sibling proposal,
[`./extensions-hooks.md`](./extensions-hooks.md), and ride the same
loader / discovery / hot-reload / trust infrastructure described
here. Tools ship first because the surface is straightforward — no
mid-run mutation contract, no ordering questions across two scopes.

## Goals

- Extension authors write a single `.ts` file that registers
  LLM-callable tools alongside swarm's built-ins (`bash`, `read`,
  `write`, `edit`, …).
- API shape is verbatim pi-coding-agent for `registerTool` — same
  fields, same execute signature, same result shape, same TypeBox-
  driven typing. Pi's TUI render fields don't transfer (swarm's web
  uses React, pi's TUI uses pi-tui Components); swarm carries a
  daemon-side `renderText` markdown fallback on the descriptor and
  ships richer per-context renderers as paired sibling files
  (`*.web.tsx`, future `*.tui.ts`). See "Web rendering" below.
- Loader, hot reload, trust, and disable mechanics mirror the skills
  pipeline (`packages/workspace/src/skills/discover.ts`) so we don't
  invent two competing UX models.
- Daemon and run-level observability via the existing `daemon_events`
  table and the per-run event log — no new schema.
- The codergen agent consumes extension-registered tools through the
  same path it consumes built-ins (`packages/agent/src/backend.ts:215`,
  `tool-adapter.ts:toAgentTool`). Extensions do not bypass the agent
  boundary.

## Non-goals (this proposal)

- **Hooks** — owned by `./extensions-hooks.md`.
- **Custom node-kinds.** `kind` stays closed; tools cover the long tail.
- **Custom commands / shortcuts / providers / message renderers / UI
  components.** pi-codergen exposes those because it's a TUI; swarm's
  TUI surface is the web app, out of scope.
- **Pi's TUI render fields verbatim** — Lit `TemplateResult` (pi
  web-ui) and pi-tui `Component` don't cross into swarm's React
  tree. Swarm carries equivalents but in swarm-shaped contracts.
  See "Web rendering".
- **Sandboxing.** Trust mirrors skills (project trusted by default).
  The credentials-in-DB threat model (`./credentials.md`) is the lever
  we pull when the blast radius gets concrete.
- **Web UI page.** Defer to a unified "plugins" page that pairs with
  `/skills` (also missing today).

## Discovery and layout

Two scopes, both active concurrently for every run:

| Scope | Path | Precedence on tool-name collision |
|---|---|---|
| Project | `<cwd>/.swarm/extensions/` | wins |
| User | `~/.swarm/extensions/` | shadowed |

Filename suffix conventions split runtime contexts so each host
loads only what it can run:

| Suffix | Loaded by | Contains |
|---|---|---|
| `*.ts`, `*/index.ts` | daemon | tool defs, hooks, daemon-side renderers (`renderText`) |
| `*.web.tsx` | web bundler | paired React renderer for tool of the same basename |
| `*.tui.ts` (future) | TUI host | paired pi-tui renderer for tool of the same basename |

The daemon's `*.ts` glob **excludes** `*.web.tsx` and `*.tui.ts` —
those files import React / pi-tui and would crash on Node import.
Pairing is by basename: `weather.ts` pairs with `weather.web.tsx`.
A renamed tool file forces a renderer rename — caught by an
`extension.load_failed` when basenames drift apart.

Useful side-case: a renderer-only file (`bash.web.tsx` alone)
overrides the renderer for an existing tool — built-in or extension-
supplied — without re-registering the tool itself. Common pattern
for projects that want richer rendering of `bash` output.

Single-file extensions and directory-with-`index.ts` are both
accepted at the daemon level. `package.json` + `node_modules/`
works for extensions that need third-party deps (jiti resolves
through the nearest `node_modules`, same as pi).

## API package

New top-level `@swarm/extension` (types only; runtime loader lives in
`@swarm/workspace` next to `skills/`):

```ts
// daemon-loaded code (tool defs, hooks)
import type {
  SwarmAPI,
  ExtensionContext,
  ToolDefinition,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@swarm/extension";

export { defineTool } from "@swarm/extension";

// paired *.web.tsx files only — pulls in React types
import type { WebRenderer } from "@swarm/extension/web";
```

The `/web` subpath export is the seam: importing it in a daemon-
loaded `*.ts` is a static-import error from the bundler (no React
in the daemon's module graph), so the runtime split shows up at
build time, not at execution.

`AgentToolResult` and `AgentToolUpdateCallback` re-export from
`@mariozechner/pi-agent-core` — already a runtime dep via
`@swarm/agent`, no new dependency for extension authors.

The split keeps user code from pulling in our runtime guts: types
from `@swarm/extension`, runtime stays internal.

## Factory shape

```ts
import { defineTool, type SwarmAPI } from "@swarm/extension";
import { Type } from "typebox";

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name, cwd: ctx.cwd },
    };
  },
});

export default function (sw: SwarmAPI) {
  sw.registerTool(helloTool);
}
```

The factory default-export is sync. Async factories are accepted
(`export default async function(sw) { ... }`) for setup that needs
`await` before registering — same as pi.

## `ToolDefinition` — pi-verbatim

```ts
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;

  /** Optional one-line snippet for the Available tools section in the
   *  default system prompt. Tools without this are omitted from the
   *  catalogue. */
  promptSnippet?: string;

  /** Optional guideline bullets appended to the system prompt's
   *  Guidelines section when this tool is active. */
  promptGuidelines?: string[];

  /** Optional compatibility shim to prepare raw tool-call arguments
   *  before TypeBox validation. Must return an object conforming to
   *  TParams. */
  prepareArguments?: (args: unknown) => Static<TParams>;

  /** Daemon-evaluated markdown renderer used for log lines, CLI
   *  feed output, and the web fallback when no paired
   *  `<name>.web.tsx` exists. Pure function — no React, no pi-tui.
   *  Swarm-specific (no pi analog). Returning undefined falls
   *  through to the host's ai-elements default, which renders the
   *  raw `result.content[0].text` in a `<CodeBlock>`. */
  renderText?(result: AgentToolResult<TDetails>, opts: { isPartial: boolean }): string | undefined;

  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  /** Hint to the agent loop to stop after this tool batch. Early
   *  termination only when every tool result in the batch sets it. */
  terminate?: boolean;
}

type AgentToolUpdateCallback<T = any> = (partial: AgentToolResult<T>) => void;
```

Fields not carried verbatim from pi:

| Pi field | Status |
|---|---|
| `renderShell?` | dropped — ai-elements `<Tool>` is swarm's equivalent, owned by host |
| `renderCall?` | dropped — call rendering is `<ToolHeader>` + `<ToolInput>`, owned by host. State badge derives from event progression, not the renderer |
| `renderResult?` | reshaped — daemon-side `renderText` (markdown fallback, above) + paired `*.web.tsx` for full React. Both carry `isPartial` so streaming `onUpdate` rounds through the same path. See "Web rendering" |
| `executionMode?` | deferred — swarm's pi-ai dispatcher honours its default; revisit if a custom tool needs strict-sequential behaviour |

`defineTool(t)` is a type-inference helper that returns its argument
unchanged — same shape as pi's. Use it when assigning a tool to a
variable so TypeScript doesn't widen `parameters` to `unknown`.

## `execute()` — pi signature, swarm `ctx`

The signature is verbatim pi: `(toolCallId, params, signal, onUpdate, ctx)`.
The `ctx` argument is **swarm-flavored** — pi's `ExtensionContext`
exposes UI primitives that don't apply, and swarm has run-scoped
primitives pi doesn't:

```ts
interface ExtensionContext {
  /** Working directory of the run. */
  readonly cwd: string;
  readonly runId: string;
  readonly nodeId: string;
  /** Per-node re-entry counter (attractor retry semantics). */
  readonly iteration: number;
  /** The current run's AbortSignal. Same instance also passed
   *  positionally as `signal`; exposed on ctx for symmetry with
   *  hooks, which receive ctx but no positional signal. */
  readonly signal: AbortSignal;

  /** HTTP client routed through swarm's wiring (no bare fetch in
   *  extension code per AGENTS.md ground rule #9, the same rule that
   *  binds in-tree handlers). */
  readonly http: HttpClient;

  /** Filesystem + shell environment scoped to the run's worktree. */
  readonly env: ExecutionEnvironment;

  /** Emit observability events. Same surface handler authors use. */
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
}
```

Pi's `ctx.ui`, `ctx.sessionManager`, `ctx.modelRegistry`, `ctx.compact`,
`ctx.abort`, `ctx.shutdown`, `ctx.getContextUsage`,
`ctx.getSystemPrompt` — none are exposed. Authors who need session-
or compaction-level operations are using the wrong tool (those are
workflow-level concerns and belong in handlers / workflow nodes).

## Swarm-side wiring

Extension-registered tools land in the same `ToolRegistry` swarm uses
for built-ins (`@swarm/workspace`'s `ToolRegistry`, where the four
core tools also live — see `packages/workspace/src/types.ts:89`). The
loader translates `ToolDefinition` → workspace `Tool` at load time:

| `ToolDefinition` field | workspace `Tool` field | Notes |
|---|---|---|
| `name`, `description`, `parameters` | identical | direct copy |
| `label` | (no equivalent) | stored on the descriptor's metadata for UI surfacing; not used at the LLM boundary |
| `promptSnippet`, `promptGuidelines` | (no equivalent today) | hung off the descriptor; consumed by `system-prompt.ts:buildSystemPrompt`. Custom tools without `promptSnippet` are omitted from the Available-tools catalogue (mirrors pi) |
| `prepareArguments` | `prepareArguments` | direct copy |
| `execute(toolCallId, params, signal, onUpdate, ctx)` | `execute(args, env, {signal, onUpdate})` | adapter wraps: pi-shape → workspace-shape. `toolCallId` and the swarm `ctx` are constructed at dispatch from the active `HandlerContext` |
| (n/a) | `idempotent` | hardcoded `false` for custom tools v0 (safe default — dangling calls require human approval on resume) |
| (n/a) | `truncation` | default `{ max_chars: 100_000, mode: "tail" }` v0; opt-in override deferred |

`AgentToolResult { content, details, terminate? }` maps to workspace
`ToolOutput { text, content?, data?, is_error? }`:

- `content[]` → `content[]` (verbatim; first text block also feeds
  `text` for renderers that don't handle multi-modal)
- `details` → `data`
- `terminate: true` is honoured by pi-ai's dispatcher (the agent loop
  exits after the tool batch); swarm doesn't need a separate
  translation — `toAgentTool` already lets pi-ai see the field.

The codergen backend at `backend.ts:215` already consumes the merged
registry via `selectedTools.map((t) => toAgentTool(t, effectiveEnv))`.
No change to the backend; the loader appends to the registry the
backend already reads.

### `recordIntent` / `recordDone`

Custom tools default to `external` side-effect classification —
every call wraps in `recordIntent` / `recordDone` facts via the
existing `externalCall` envelope. Safe but verbose default. An opt-
in `sideEffect?: "none" | "idempotent" | "external"` field on
`ToolDefinition` is **deferred** until concrete event-volume pressure
or a tool author explicitly needs the optimisation.

## Web rendering

The web conversation view
(`packages/web/src/components/RunConversation.tsx`) renders every
tool call through ai-elements primitives
(`packages/web/src/components/ai-elements/tool.tsx`):

```tsx
<Tool>
  <ToolHeader type="dynamic-tool" toolName={name} state={state} />
  <ToolContent>
    <ToolInput input={params} />
    <ToolOutput output={result.content} errorText={result.isError ? … : ""} />
  </ToolContent>
</Tool>
```

State badges, icons, the collapsible chrome, and the JSON
formatting of inputs / outputs all live in this shell — not in
per-tool renderers. Swarm renderers slot **into** the shell rather
than rebuild it.

### Three-tier render chain

| Tier | Author ships | Behaviour |
|---|---|---|
| **default** | nothing | full ai-elements shell. `<ToolOutput>` formats `result.content` as JSON or text. Status badge derived from event state |
| **`renderText`** (daemon-side, markdown) | `renderText(result, { isPartial }) → string \| undefined` on the descriptor | full ai-elements shell. The string returned replaces `<ToolOutput>`'s body, rendered through swarm's existing markdown renderer |
| **paired `*.web.tsx`** (full React) | a sibling `<name>.web.tsx` exporting a `WebRenderer` | depends on `isCustom` (below) |

Each tier falls through to the next if absent. A tool with neither
`renderText` nor `*.web.tsx` still renders cleanly — the ai-elements
default is the floor, not an empty state.

### `WebRenderer` contract

```ts
// @swarm/extension/web — paired *.web.tsx files import this
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface WebRenderer<TParams = any, TDetails = any> {
  /** Optional icon for the ai-elements <ToolHeader>. Pass the Lucide
   *  component directly — no string lookup. Falls back to WrenchIcon
   *  if unset. The `render` field is also optional, so a paired
   *  `*.web.tsx` that only customises the icon is a valid extension:
   *  `export default { icon: Cloud } satisfies WebRenderer;` */
  icon?: LucideIcon;

  render?(
    params: TParams | undefined,
    result: ToolResultMessage<TDetails> | undefined,
    opts: { isStreaming: boolean; isPartial: boolean },
  ): { content: ReactNode; isCustom?: boolean };
}
```

Signature mirrors pi-web-ui's `ToolRenderer.render` (params + result
+ streaming flag) with the framework swap (Lit `TemplateResult` →
React `ReactNode`) and `isPartial` lifted out of pi's
`ToolRenderResultOptions`. Authors familiar with pi-web-ui transfer
1:1 modulo JSX.

`isCustom` keys the slot:

- **`isCustom: false`** (default) — `content` replaces only the
  `<ToolOutput>` body. `<Tool>` + `<ToolHeader>` + `<ToolInput>` and
  the state badge stay. This is the right choice for ~all tools —
  custom output rendering, default chrome.
- **`isCustom: true`** — `content` replaces the entire `<Tool>`
  card. Use only when the tool has a card-level visualisation
  (e.g. an inline chart, a dashboard tile) that can't live inside
  the standard shell.

Authors that need access to `params` for the input area can already
override `<ToolInput>`'s formatting from a `*.web.tsx`; the
`WebRenderer.render` call covers both the input and output halves
implicitly because it can return any JSX layout. v0 keeps the slot
narrow (just output replacement) and revisits if a real tool wants
input customisation independently.

### `Tool` component reshape (v0 implementation scope)

`packages/web/src/components/ai-elements/tool.tsx` currently keys
its props on the AI-SDK `ToolUIPart` type
(`output: ToolPart["output"]`, etc.). The custom-tool render path
wants swarm-native types (`AgentToolResult`, `ToolResultMessage`)
without bending through AI-SDK shapes. Part of v0 implementation:
widen `ToolInputProps` / `ToolOutputProps` to a small swarm-native
union that the existing AI-SDK callers also satisfy. No public-API
break for the AI-SDK call sites; new prop overload for the swarm
renderer path.

### Streaming `onUpdate`

Pi tools call `onUpdate(partial)` to stream progress. The adapter
at `tool-adapter.ts:83` already forwards this to a
`tool.execution_update` event. For renderers, the same render
function is invoked with `{ isStreaming: true, isPartial: true }`
on each partial; renderers that ignore the flags get re-renders for
free, renderers that care branch on them. No separate "partial
render" path.

### Icons

Icons live on the paired `*.web.tsx` only — the actual `LucideIcon`
component, not a string name. The descriptor stays Lucide-free
(daemon module graph unaffected); a custom icon costs an extra file
but the file can be a one-liner:

```tsx
// weather.web.tsx — icon-only override
import { Cloud } from "lucide-react";
import type { WebRenderer } from "@swarm/extension/web";

export default { icon: Cloud } satisfies WebRenderer;
```

Resolution in ai-elements `<ToolHeader>`:

1. `WebRenderer.icon` from the paired `*.web.tsx`.
2. `WrenchIcon` — the existing unknown-tool fallback at
   `tool.tsx:178`.

Tools without an icon don't need a `*.web.tsx`. Tools that want a
distinctive icon ship a stub paired file. The same paired file can
add `render` later without touching the descriptor — `WebRenderer`
is `{ icon?, render? }` with both optional.

## Hot reload

`node:fs` `watch` on the two extension roots, with a thin retry
wrapper for the inode-change footgun (mirrors pi's
`packages/coding-agent/src/utils/fs-watch.ts`). chokidar deliberately
not introduced.

- File changed → re-run loader → atomic swap of
  `(extensionId → registeredTools)`.
- In-flight runs see the registry version captured at dispatch
  (snapshot-at-dispatch). The new version applies on the next
  dispatch.
- Reload of a file that no longer parses → keep previous version
  active, emit `extension.load_failed`, surface in `extensions list`.
- Debounce window: 250 ms (matches pi's `watchFile` interval).
  Multiple saves within the window collapse to one reload.

## Trust model

V0: mirror skills.

```jsonc
{
  "extensions": {
    "trustProject": true,             // false hides project extensions
    "disabled": ["audit", "policy"]   // exclusion list (matches name)
  }
}
```

Project extensions trusted by default. `trustProject=false` keeps the
discovery scan but skips loading; the entry surfaces in
`extensions list` with `disabled_reason: "project scope hidden"`. The
`disabled` array hard-skips by name regardless of scope.

The structural risk — a hostile project extension reading other
projects' secrets via `bun:sqlite` — is acknowledged and deferred to
the credentials-in-DB proposal (`./credentials.md`). v0 ships with a
loud `extensions: <N> project tools loaded` line in daemon startup
logs so the operator sees what's loaded.

## Observability

### Run-scoped (per-run event log)

Existing `tool.execution_*` events get a new optional field:
`source: "core" | "extension:<extensionId>"`. No new event type, no
new payload pressure beyond the source string.

### Daemon-scoped (existing `daemon_events` table)

| Event | When | Payload |
|---|---|---|
| `extension.loaded` | boot or successful reload | `{ extensionId, scope, sourcePath, sha256, registeredTools }` |
| `extension.load_failed` | parse / loader throws | `{ extensionId, sourcePath, error }` |
| `extension.unloaded` | file deleted, or name conflict shadowing | `{ extensionId, reason }` |
| `extension.reload_started` | watcher fires | `{ extensionId, sourcePath, trigger }` |

`registeredTools` is `[{ name, label, hasPromptSnippet }]` — metadata
only, not function refs. Payloads stay under the 4 KB
`daemon_events.payload` cap (`packages/store/src/schema.sql:184`).

`extensionId` is `<scope>:<basename>` — e.g. `project:hello`,
`user:weather`. Collision-free across scopes; the `disabled: []`
array matches by basename so authors don't have to know which scope
their extension lands in.

## CLI / API surface (no UI in this proposal)

- `GET /extensions` — list of `{ extensionId, scope, sourcePath,
  sha256, registeredTools, loadedAt, disabled, lastError? }`.
- `GET /daemon/events?type=extension.*` — already present via
  `getDaemonEvents`; just exercises the existing reader.
- `swarm extensions list` — table-formatted CLI of the same.
- `swarm extensions reload <extensionId>` — manual reload trigger
  (debugging convenience; the watcher is the primary path).

A future "plugins" web page renders this same shape alongside skills.
Tracked separately so the API surface lands without waiting on UI.

## Test plan

Unit:

- Loader scans both scopes, applies project-beats-user collision
  rule, warns on shadow.
- Loader excludes `*.web.tsx` and `*.tui.ts` from the daemon glob;
  basename pairing surfaces as metadata on the descriptor.
- TypeBox parameter schema validation rejects malformed `parameters`.
- Adapter translates `ToolDefinition` → workspace `Tool` faithfully:
  `prepareArguments` round-trips, `execute` signature is wrapped
  correctly, `AgentToolResult.content` lands verbatim in
  `ToolOutput.content`, `details` lands in `data`.
- `terminate: true` flag survives the adapter and reaches pi-ai's
  dispatcher.
- `renderText` invoked with `isPartial: true` on `onUpdate` partials
  and `isPartial: false` on the final result.
- Hot reload: file change re-registers; in-flight tool call still
  sees the snapshot; failed reload preserves prior version.
- Trust model: `trustProject=false` skips project extensions;
  `disabled: ["foo"]` skips by name across scopes.

Integration:

- End-to-end with a real codergen run: a project extension registers
  a tool, the LLM is steered to call it, the tool's response
  surfaces in `tool.execution_end` with
  `source: "extension:project:foo"`.
- `promptSnippet` from the extension's tool appears in the system
  prompt's Available-tools section.
- `daemon_events` rows for `extension.loaded`,
  `extension.load_failed`, `extension.unloaded`.

Web (Vitest / Playwright):

- A tool with no `renderText` and no `*.web.tsx` renders through the
  ai-elements default with the wrench icon and humanised label.
- A paired `*.web.tsx` exporting `{ icon: Cloud }` only (no
  `render`) overrides the header icon while leaving the rest of
  the ai-elements default in place.
- A tool with `renderText` only renders its markdown inside
  `<ToolOutput>` while `<Tool>` / `<ToolHeader>` / `<ToolInput>`
  stay default.
- A paired `*.web.tsx` with `isCustom: false` slots its `content`
  into `<ToolContent>`'s output position; header + input remain
  ai-elements.
- A paired `*.web.tsx` with `isCustom: true` replaces the entire
  `<Tool>` card.
- A renderer-only `bash.web.tsx` overrides built-in bash rendering
  without re-registering the tool.
- Streaming: render fires on each `tool.execution_update` with
  `isStreaming: true; isPartial: true`, and once on
  `tool.execution_end` with both false.

Discipline:

- Lint test (extension to `handler-discipline-extensions.md`) rejects
  custom tools importing `bun:sqlite`, `node:child_process` outside
  `ctx.env.exec`. Defers the AST work to that proposal but the test
  hook lives here.

## Open questions

All v0-blocking questions are resolved (see "Web rendering"). The
remaining items are additive knobs.

1. **Tool-name collisions with built-ins.** Today
   `ToolRegistry.register` throws on duplicate names — a custom
   `bash` surfaces as `extension.load_failed`. Hard-reject is
   correct for v0; revisit if a use case for "shadow the built-in
   on this project" emerges (rare; the renderer-only override path
   already handles "I want bash to *render* differently").
2. **`sideEffect` opt-in.** v0 hardcodes `external`. Tools that are
   genuinely side-effect-free (`random`, `now`, math evaluators)
   pay needless `recordIntent`/`recordDone` event traffic. Additive;
   defer until volume pressure or an author asks.
3. **`promptGuidelines` ordering across scopes.** When both project
   and user extensions contribute guidelines, what order do they
   land in the system prompt? Standard answer: `(scope, sourcePath,
   registrationOrder)` with project first. State once we ship.
4. **`executionMode` opt-in.** Revisit if a custom tool needs
   strict-sequential dispatch (e.g. DB migrations).
5. **`truncation` policy override.** v0 default is `{max_chars:
   100_000, mode: "tail"}`. Per-tool override is additive.
6. **AST-at-registration cost.** Hot reload makes parsing per-edit
   rather than per-boot. Probably negligible (jiti parses anyway).
   Benchmark before declaring it free.
7. **Independent `<ToolInput>` override.** v0's `WebRenderer.render`
   covers both halves implicitly (returns one ReactNode). If a tool
   wants to customise only the input area, it has to take over the
   whole row. Real demand → split into `{ input?, output? }` slots.

## What this does not commit to

- **Hooks** — owned by [`./extensions-hooks.md`](./extensions-hooks.md).
- **Custom call-time chrome** beyond `<ToolHeader>` + `<ToolInput>`.
  State badge, icon, collapsible behaviour are owned by ai-elements
  (consistent across tools by design). Renderers can opt out of the
  shell entirely via `WebRenderer.isCustom = true`, but per-tool
  themable chrome is not in scope.
- **TUI render path.** Reserved file convention (`*.tui.ts`) but no
  loader, no shape, no proposal until the TUI itself ships.
- **Code-loaded daemon-side renderers.** `renderText` is markdown-
  only; the spec-based typed-`kind` union sketched in earlier drafts
  is deferred. Markdown covers v0; graduate when authors hit limits.
- **Sandboxing or capability-based permissions.** Deferred to
  `credentials.md` resolution.
- **Cross-project read isolation.** Same.
- **Replay determinism via `project_context_sha`.** The schema field
  exists for this reason, but populating it is a follow-up once the
  loader's content-hash surface stabilises.
- **A `/extensions` web page.** Ship the API surface here, ship the
  page in a separate UI proposal.

## v0 status (2026-05-04)

**Landed:**

- `@swarm/extension` types-only package (`SwarmAPI`,
  `ExtensionContext`, `ToolDefinition`, `defineTool`, `WebRenderer`
  on the `/web` subpath).
- Workspace loader at `packages/workspace/src/extensions/`:
  discovery (project + user scopes, suffix filtering, basename
  validation, collision resolution), dynamic-import via Bun's native
  TS loader, `ToolDefinition → workspace Tool` adapter.
- `ToolExecuteOptions.swarmContext` slot threaded through
  `tool-adapter.ts:toAgentTool` so extension tools receive
  `runId / nodeId / iteration / http / emit / summarise`.
- `SummariseInput.system_prompt_override` field — extension tools
  that need a generic small-model call (e.g. `web_fetch`) bypass the
  summariser's purpose-derived prompt.
- Daemon boot wires `loadExtensions` alongside `discoverSkills`;
  loaded tools merge into the `ToolRegistry` after `CORE_TOOLS`.
- Reference extension at `<repo>/.swarm/extensions/web_fetch.ts` —
  fetch + HTML→markdown + summarise.
- 16 unit tests across discovery + loader (project-beats-user
  precedence, suffix exclusion, basename validation,
  trustProject/disabled config, swarmContext threading, renderText
  fallback, factory-throws / no-default-export errors).

**Outstanding (tracked here as in-progress):**

- Hot reload via `node:fs.watch` — v0 scans once at daemon boot.
- `daemon_events` emission for `extension.loaded` / `load_failed` /
  `unloaded` / `reload_started`. v0 prints to console; the audit
  log isn't populated.
- Trust config wiring — the loader honours
  `extensions.trustProject` / `extensions.disabled` when passed but
  the daemon doesn't read them from `.swarm/config.jsonc` yet (the
  config schema needs the new section).
- `swarm extensions list` / `swarm extensions reload` CLI subcommands.
- `GET /extensions` HTTP route + `source: "extension:<id>"` field
  on `tool.execution_*` events.
- Web bundler integration for paired `*.web.tsx` renderers — v0
  delivers only the daemon-side `renderText` markdown fallback. The
  ai-elements default still renders unknown tools with the wrench
  icon and JSON output.
- `Tool` component reshape (props off AI-SDK's `ToolUIPart`) — the
  paired-renderer integration depends on it.

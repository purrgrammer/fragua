# swarm — backlog

Items deferred from analysis passes. Not active work; pick up when the
surrounding subsystem gets revisited.

---

## Preserve pre-truncation tool output to `artifacts`

**Problem.** `packages/agent/src/tool-adapter.ts:29` runs `truncate()` on
raw tool output before returning to pi-agent-core. The pre-truncation
text is discarded — not written to `artifacts`, not captured by the
event stream (4KB cap, §I7), not captured by the `messages` table (which
stores only what the agent saw). `details.original_length` records how
much was cut but not *what* was cut.

Invariant §I8 says raw tool output belongs in `artifacts` as a
content-addressed blob with a named ref scoped by `(run, node, iteration,
key)`. Agent-internal tool invocations currently skip that path.

**Shape of the fix.** Plumb `runId` + `nodeId` + `iteration` +
`tool_call_id` into `toAgentTool` so the adapter calls
`ctx.artifacts.put(<toolCallId>:stdout, result.text)` before truncating.
The tool-adapter's truncation warning then carries the artifact ref so
debuggers (and the swarm-debug skill §7) have a direct retrieval path:

```
[truncated — full output at artifacts(<node>, iter=<n>, key="<tool_call_id>:stdout")]
```

**Why deferred.** Requires plumbing executor-owned context through the
workspace/agent/core boundary. Not on fire — the existing warning is
now honest ("was truncated"), just lossy.

---

## Custom message types via `CustomAgentMessages` declaration merging

**Problem.** `messages.role` is `CHECK (role IN ('system','user','assistant','tool'))`
— a narrow surface deliberate for the MVP transcript. pi-coding-agent
extends pi-agent-core's `CustomAgentMessages` interface with
`bashExecution`, `custom`, `branchSummary`, `compactionSummary` — each
carrying structured `details` and a `convertToLlm` transformer that
folds them back into LLM-visible messages.

**Potential uses in swarm.**
- Summariser output as a first-class message (currently a synthetic
  `__summary.title` node id on events + `run_state.title` projection —
  can't render in the transcript).
- HITL input as a first-class message (currently an `intent.*` event; the
  transcript UI has to reach into events to render human turns inline).
- Parallel-branch fan_in decisions.

**Why deferred.** Schema migration (CHECK constraint) + projection
changes + consumer updates across server/web/agent. Tie to the next
major messages-table revision.

**Reference.** `packages/coding-agent/src/core/messages.ts` in pi-mono.

---

## Compaction with file-operation tracking

**Problem.** swarm's summariser (`@swarm/agent` fidelity modes) reduces
message text only. pi-coding-agent's compaction additionally extracts
which files the agent read vs. modified across compactions, maintaining
running `readFiles` / `modifiedFiles` lists as `CompactionDetails`. Lets
long-running agents answer "have I already looked at X?" across summary
boundaries.

**Why deferred.** swarm's summariser hasn't proven constrained by the
lack of file-op awareness yet. Adopt when summary fidelity becomes the
limiting factor on long runs (or when budget enforcement — §13.1 — lands
and needs a running "touched files" view for cost-attribution heuristics).

**Reference.** `packages/coding-agent/src/core/compaction/` in pi-mono.

---

## File-mutation serialization under shared worktrees

**Problem.** Not today. pi-coding-agent serializes concurrent file writes
to the same realpath via `withFileMutationQueue`. swarm avoids this by
design: `WorktreeProvisioner` gives each run its own filesystem, and
parallel branches within a run are read-only by contract (§13.1 regime C).

**When this becomes relevant.** If "parallel" ever loosens beyond
deliberation-only — e.g., fan-out branches that write to a shared
scratch dir — lift pi-coding-agent's pattern directly. `realpathSync`
canonicalization + per-key promise queue, map cleaned up when idle.

**Reference.** `packages/coding-agent/src/core/tools/file-mutation-queue.ts`.

---

## UI rendering of `<thinking>` / `<tool_use>` / `<tool_result>` tags

**Problem.** `messages.content` now carries structured tags (post
`packages/agent/src/backend.ts` rewrite). `packages/web` still renders
the column as plaintext. Result: `<tool_use id="..." name="read">{"path":"..."}</tool_use>`
appears literally in `RunConversation`.

**Shape of the fix.** Parser in `packages/web` that splits content into a
`Block[]` (text, thinking, tool_use, tool_result) — non-greedy matches,
pairs tool_use↔tool_result by id within the message stream — and renders
each with a dedicated component:

- `<thinking>` → collapsible panel with shimmer (see
  [AI SDK Elements `reasoning`](https://elements.ai-sdk.dev/components/reasoning),
  optionally [`chain-of-thought`](https://elements.ai-sdk.dev/components/chain-of-thought)).
- `<tool_use>` + matched `<tool_result>` → tool-call card with name,
  args (JSON-pretty), result body, error flag.
- text → existing markdown renderer.

Out of scope for the backend serialization PR; next UI pass.

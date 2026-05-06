// NodeInspector — read-only side-panel that surfaces the full attribute
// shape of a single workflow node.
//
// Used by:
//   - `WorkflowDetail` (static view)  — driven by a parsed `Node` with
//     no lifecycle state.
//   - `RunGraphTab` (live view)  — same `Node` plus a matching
//     `NodeState` entry from the event stream, so the inspector can
//     show current state + lastEventSeq alongside the static config.
//
// Design intent: this panel is the "I clicked a node, what does it do?"
// answer. Sections are visually flat — uppercase labels carry hierarchy,
// hairlines separate, no background shade changes. Long prompts render
// inside `<pre>` so whitespace is preserved and the block doesn't bleed
// into the adjacent section. When there's nothing to show (no selection)
// the panel renders a hint instead of collapsing — the layout stays
// stable so the graph doesn't reflow on click.

import { type Node as GraphNode, handlerOf } from "@swarm/core";
import type { NodeState } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { canRetry, showsLlm } from "../lib/node-metadata.ts";
import { ModelSelectorLogo } from "./ai-elements/model-selector.tsx";

export interface NodeInspectorProps {
  /** Parsed workflow node to inspect. `null` renders the empty hint. */
  node: GraphNode | null;
  /**
   * Live lifecycle state for the node, when available. Absent on the
   * workflow-detail route (static view). When present, shows the
   * current `state` and `lastEventSeq` in the identity section.
   */
  state?: NodeState | null;
  className?: string;
}

export function NodeInspector({ node, state, className }: NodeInspectorProps): JSX.Element {
  if (!node) {
    return (
      <aside
        data-testid="node-inspector-empty"
        className={cn(
          "flex min-h-[480px] flex-col items-center justify-center gap-2 rounded-sw-card border border-sw-border bg-sw-surface p-4 text-center",
          className,
        )}
      >
        <p className="text-sw-xs uppercase tracking-[0.06em] text-sw-muted">no selection</p>
        <p className="max-w-[28ch] text-sw-sm text-sw-text">Click a node in the graph to inspect its configuration.</p>
      </aside>
    );
  }

  const attrs = node.attrs;
  const handler = handlerOf(node);
  // Per-handler relevance gates — see lib/node-metadata.ts. The drawer
  // and the GraphView card share these predicates so a tool node never
  // surfaces an LLM section just because the stylesheet cascade pinned
  // an `llm_model` attr it'll never call.
  const llmRelevant = showsLlm(handler, attrs);
  const retryRelevant = canRetry(handler);
  const skills = attrs.skills ?? [];
  const allowedTools = attrs.allowed_tools ?? [];
  const deniedTools = attrs.denied_tools ?? [];
  const contextFiles = attrs.context_files ?? [];

  return (
    <aside
      data-testid="node-inspector"
      data-node-id={node.id}
      data-handler={handler}
      className={cn(
        "flex min-h-[480px] flex-col gap-0 overflow-auto rounded-sw-card border border-sw-border bg-sw-surface",
        className,
      )}
    >
      {/* Identity */}
      <Section title="identity">
        <Field label="id" value={<code className="text-sw-text">{node.id}</code>} />
        {attrs.label && <Field label="label" value={attrs.label} />}
        <Field label="handler" value={<code className="text-sw-text">{handler}</code>} />
        {/* class drives stylesheet `.classname` matching (§8.3). Show
         *  comma-separated when multiple classes resolve (the parsed
         *  Node.classes carries derived classes from subgraph membership
         *  too — that's the source of truth, not the raw `class` attr). */}
        {node.classes.length > 0 && (
          <Field label="class" value={<code className="text-sw-text">{node.classes.join(", ")}</code>} />
        )}
        {/* thread_id — shared LLM session marker. Identity rather than
         *  model-section because it's about *which conversation* this node
         *  joins, not what model handles it. Suppressed for non-LLM
         *  handlers (tool / start / exit / heuristic fan-in) so the
         *  cascade-resolved value doesn't mislead. */}
        {llmRelevant && attrs.thread_id && (
          <Field label="thread" value={<code className="text-sw-text">{attrs.thread_id}</code>} />
        )}
        {state && <Field label="state" value={<code className="text-sw-text">{state.state}</code>} />}
        {state && state.lastEventSeq > 0 && (
          <Field label="last event" value={<code className="text-sw-text">seq {state.lastEventSeq}</code>} />
        )}
      </Section>

      {/* Model & context. Gated on `showsLlm` so the section vanishes
       *  for handlers that never call an LLM (tool / start / exit /
       *  conditional / heuristic parallel.fan_in) even when the
       *  stylesheet cascade resolved an llm_model. */}
      {llmRelevant &&
        (attrs.llm_model || attrs.llm_provider || attrs.context || attrs.fidelity || attrs.reasoning_effort) && (
          <Section title="model & context">
            {attrs.llm_model && <Field label="model" value={<code className="text-sw-text">{attrs.llm_model}</code>} />}
            {attrs.llm_provider && (
              <Field
                label="provider"
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <ModelSelectorLogo provider={attrs.llm_provider} />
                    <code className="text-sw-text">{attrs.llm_provider}</code>
                  </span>
                }
              />
            )}
            {attrs.context && <Field label="context" value={<code className="text-sw-text">{attrs.context}</code>} />}
            {attrs.fidelity && (
              <Field label="fidelity" value={<code className="text-sw-text">{attrs.fidelity}</code>} />
            )}
            {attrs.reasoning_effort && (
              <Field label="reasoning" value={<code className="text-sw-text">{attrs.reasoning_effort}</code>} />
            )}
          </Section>
        )}

      {/* Parallel — fan-in target is the convergent tripleoctagon, discovered
       *  by the runtime via edges (attractor §4.8). The `fan_in` attr is the
       *  swarm-author convention for declaring it explicitly; show whichever
       *  is set so authors can confirm the wiring without leaving the panel. */}
      {(attrs.join_policy !== undefined || typeof attrs["fan_in"] === "string") && (
        <Section title="parallel">
          {typeof attrs["fan_in"] === "string" && (attrs["fan_in"] as string).length > 0 && (
            <Field label="fan_in" value={<code className="text-sw-text">{attrs["fan_in"] as string}</code>} />
          )}
          {attrs.join_policy !== undefined && (
            <Field label="join policy" value={<code className="text-sw-text">{attrs.join_policy}</code>} />
          )}
        </Section>
      )}

      {/* Tool (graph-level shell step) */}
      {typeof attrs.tool_command === "string" && attrs.tool_command.length > 0 && (
        <Section title="tool">
          <Field
            label="command"
            value={
              <pre
                className="whitespace-pre-wrap break-words rounded bg-sw-surface-muted p-sw-xs text-sw-xs text-sw-text"
                data-testid="node-inspector-tool-command"
              >
                {attrs.tool_command}
              </pre>
            }
          />
        </Section>
      )}

      {/* Tools */}
      {(allowedTools.length > 0 || deniedTools.length > 0) && (
        <Section title="tools">
          {allowedTools.length > 0 && <ListField label="allowed" items={allowedTools} />}
          {deniedTools.length > 0 && <ListField label="denied" items={deniedTools} />}
        </Section>
      )}

      {/* Skills */}
      {(skills.length > 0 || attrs.skills_disabled) && (
        <Section title="skills">
          {attrs.skills_disabled ? (
            <Field label="status" value={<code className="text-sw-text">disabled</code>} />
          ) : (
            <ListField label="scoped" items={skills} />
          )}
        </Section>
      )}

      {/* Context files */}
      {contextFiles.length > 0 && (
        <Section title="context files">
          <ListField label="files" items={contextFiles} />
        </Section>
      )}

      {/* Execution — retries, gates, timeouts, budget. Retry-shaped
       *  rows (max_retries, retry_policy, retry_target,
       *  fallback_retry_target) are gated on `canRetry(handler)` so
       *  start / exit / parallel components don't surface a value
       *  the executor can't act on. Budget + gate rows stay ungated:
       *  `goal_gate`, `timeout`, `max_cost_usd`, etc. apply uniformly. */}
      {((retryRelevant &&
        (attrs.max_retries !== undefined ||
          attrs.retry_policy !== undefined ||
          attrs.retry_target !== undefined ||
          attrs.fallback_retry_target !== undefined)) ||
        attrs.timeout !== undefined ||
        attrs.idle_timeout !== undefined ||
        attrs.max_cost_usd !== undefined ||
        attrs.max_tokens !== undefined ||
        attrs.goal_gate !== undefined ||
        attrs.allow_partial !== undefined ||
        attrs.auto_status !== undefined) && (
        <Section title="execution">
          {retryRelevant && attrs.retry_policy !== undefined && (
            <Field label="retry policy" value={<code className="text-sw-text">{attrs.retry_policy}</code>} />
          )}
          {retryRelevant && attrs.max_retries !== undefined && (
            <Field label="max retries" value={<code className="text-sw-text">{attrs.max_retries}</code>} />
          )}
          {attrs.timeout !== undefined && (
            <Field label="timeout" value={<code className="text-sw-text">{attrs.timeout}</code>} />
          )}
          {attrs.idle_timeout !== undefined && (
            <Field label="idle timeout" value={<code className="text-sw-text">{attrs.idle_timeout}s</code>} />
          )}
          {attrs.max_cost_usd !== undefined && (
            <Field label="max cost" value={<code className="text-sw-text">${attrs.max_cost_usd}</code>} />
          )}
          {attrs.max_tokens !== undefined && (
            <Field label="max tokens" value={<code className="text-sw-text">{attrs.max_tokens}</code>} />
          )}
          {attrs.goal_gate !== undefined && (
            <Field label="goal gate" value={<code className="text-sw-text">{String(attrs.goal_gate)}</code>} />
          )}
          {/* §3.4 retarget chain — gate-level only. Graph-level retarget
           *  is set on the graph attrs, not the node, so we can't show it
           *  from here without plumbing the parent in. */}
          {retryRelevant && typeof attrs.retry_target === "string" && attrs.retry_target.length > 0 && (
            <Field label="retry target" value={<code className="text-sw-text">{attrs.retry_target}</code>} />
          )}
          {retryRelevant &&
            typeof attrs.fallback_retry_target === "string" &&
            attrs.fallback_retry_target.length > 0 && (
              <Field
                label="fallback target"
                value={<code className="text-sw-text">{attrs.fallback_retry_target}</code>}
              />
            )}
          {attrs.allow_partial !== undefined && (
            <Field label="allow partial" value={<code className="text-sw-text">{String(attrs.allow_partial)}</code>} />
          )}
          {attrs.auto_status !== undefined && (
            <Field label="auto status" value={<code className="text-sw-text">{String(attrs.auto_status)}</code>} />
          )}
        </Section>
      )}

      {/* Prompt */}
      {attrs.prompt && (
        <Section title="prompt">
          <pre
            data-testid="node-inspector-prompt"
            className="whitespace-pre-wrap break-words px-3 py-2 text-sw-xs text-sw-text"
          >
            {attrs.prompt}
          </pre>
        </Section>
      )}

      {/* System prompt override */}
      {attrs.system_prompt && (
        <Section title="system prompt override">
          <pre
            data-testid="node-inspector-system-prompt"
            className="whitespace-pre-wrap break-words px-3 py-2 text-sw-xs text-sw-text"
          >
            {attrs.system_prompt}
          </pre>
        </Section>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col border-b border-sw-border last:border-b-0">
      <h3 className="px-3 py-2 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">{title}</h3>
      <div className="flex flex-col gap-1 px-3 pb-3">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-sw-sm text-sw-text">{value}</span>
    </div>
  );
}

function ListField({ label, items }: { label: string; items: readonly string[] }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-sw-xs uppercase tracking-[0.06em] text-sw-muted">{label}</span>
      <ul className="flex min-w-0 flex-1 flex-wrap gap-1">
        {items.map((item) => (
          <li key={item}>
            <code className="rounded-sw-default border border-sw-border px-1 py-0.5 text-sw-xs text-sw-text">
              {item}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Translate a `ToolDefinition` (pi-shaped) → a workspace `Tool`. The
// extension's execute receives a constructed `ExtensionContext`
// (cwd / runId / nodeId / iteration / signal / http / env / emit /
// summarise) — sourced from the per-call `swarmContext` slot we
// added to `ToolExecuteOptions`.
//
// AgentToolResult { content, details, terminate? } maps to ToolOutput
// { text, content?, data?, is_error? } as documented in the proposal.

import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@swarm/extension";
import type { AnyTool, Tool, ToolExecuteOptions, ToolOutput } from "../types.ts";

const DEFAULT_MAX_CHARS = 100_000;

/** Wrap a `ToolDefinition` so it slots into the existing workspace
 * `ToolRegistry` alongside built-ins. The wrapper:
 *
 *   - Validates `swarmContext` is present at call time (extension tools
 *     can't run without it).
 *   - Builds an `ExtensionContext` from `swarmContext` + `env`.
 *   - Invokes `toolDef.execute` with the pi-shape positional args.
 *   - Maps the returned `AgentToolResult` to `ToolOutput`.
 */
export function adaptExtensionTool(
  toolDef: ToolDefinition,
  meta: { extensionId: string; scope: "user" | "project" },
): AnyTool {
  const wrapped: Tool<Record<string, unknown>, unknown> = {
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    // Extension tools v0 default to non-idempotent + 100 KB tail
    // truncation. Per-tool override is deferred to a future
    // proposal field (see extensions-tools.md open questions).
    idempotent: false,
    truncation: { max_chars: DEFAULT_MAX_CHARS, mode: "tail" },
    ...(toolDef.prepareArguments
      ? { prepareArguments: toolDef.prepareArguments as (input: unknown) => Record<string, unknown> }
      : {}),
    async execute(args, env, opts: ToolExecuteOptions<unknown> = {}) {
      const swarmCtx = opts.swarmContext;
      if (!swarmCtx) {
        return errorOutput(
          toolDef.name,
          `extension tool "${toolDef.name}" (${meta.extensionId}) called without swarmContext — ` +
            "this is a host bug; extension tools require run-scoped context that the codergen backend supplies.",
        );
      }

      const signal = opts.signal;

      const ctx: ExtensionContext = {
        cwd: env.cwd(),
        runId: swarmCtx.runId,
        nodeId: swarmCtx.nodeId,
        iteration: swarmCtx.iteration,
        signal: signal ?? new AbortController().signal,
        http: swarmCtx.http,
        env,
        emit: swarmCtx.emit,
        ...(swarmCtx.summarise ? { summarise: swarmCtx.summarise } : {}),
      };

      const onUpdateAdapter: AgentToolUpdateCallback<unknown> | undefined = opts.onUpdate
        ? (partial: AgentToolResult<unknown>) => {
            opts.onUpdate?.(agentResultToToolOutput(partial, toolDef, true));
          }
        : undefined;

      const tool_call_id = `ext-${meta.extensionId}-${Date.now().toString(36)}`;

      try {
        const result = await toolDef.execute(
          tool_call_id,
          args,
          signal,
          onUpdateAdapter as AgentToolUpdateCallback<unknown> | undefined,
          ctx,
        );
        return agentResultToToolOutput(result, toolDef, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorOutput(toolDef.name, `extension tool "${toolDef.name}" threw: ${message}`);
      }
    },
  };
  return wrapped as AnyTool;
}

function agentResultToToolOutput(
  result: AgentToolResult<unknown>,
  toolDef: ToolDefinition,
  isPartial: boolean,
): ToolOutput<unknown> {
  // Prefer the daemon-side renderText markdown when the descriptor
  // ships one; the workspace `text` field is what the LLM actually
  // sees post-truncation. Fall back to the first text block in
  // `content`. Empty result → empty string (lets the agent loop carry
  // on without crashing on undefined.text).
  let text = "";
  if (toolDef.renderText) {
    const rendered = toolDef.renderText(result, { isPartial });
    if (typeof rendered === "string") text = rendered;
  }
  if (text === "") {
    const firstText = result.content.find((b): b is TextContent => b.type === "text");
    text = firstText?.text ?? "";
  }
  return {
    text,
    content: result.content,
    data: result.details,
  };
}

function errorOutput(toolName: string, message: string): ToolOutput<unknown> {
  return {
    text: message,
    content: [{ type: "text", text: message }],
    is_error: true,
    data: { swarm_tool: toolName, is_error: true } as Record<string, unknown>,
  };
}

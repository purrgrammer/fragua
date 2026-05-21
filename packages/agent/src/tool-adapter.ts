// Convert a fragua Tool into a pi-agent-core AgentTool. The resulting
// AgentTool closes over the ExecutionEnvironment so the LLM's tool-call
// args flow into our workspace implementation.
//
// What this adapter forwards now (post power-tool port):
//   - `prepareArguments`: optional shim that runs before schema
//     validation, so the edit tool can recover from JSON-stringified
//     `edits` arrays and legacy `{oldText, newText}` flat shape.
//   - `signal`: the agent loop's per-call AbortSignal; the bash tool
//     pipes it into env.exec for process-tree termination.
//   - `onUpdate`: pi-agent-core's streaming callback. We translate
//     fragua `ToolOutput` partials into AgentToolResult partials so
//     the UI can render mid-execution progress.
//   - `content[]`: when a fragua tool returns rich blocks (image read),
//     we forward them verbatim. Otherwise we wrap the truncated
//     `text` in a single TextContent block, preserving prior behaviour.
//   - `terminate`: a fragua tool can hint the agent loop to stop after
//     the current batch (the `abort` tool sets it); forwarded onto
//     pi-agent-core's `AgentToolResult.terminate`.

import type { ExecutionEnvironment, FraguaToolContext, Tool, ToolOutput } from "@fragua/workspace";
import { PathEscapeError, truncate } from "@fragua/workspace";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

/** Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$` — `:` is rejected.
 * We encode namespaces with `__` on the wire and reverse at event-bridge time
 * for human-readable logs. `__` is safe because fragua tool slugs use single `_`. */
export function sanitizeToolName(fraguaName: string): string {
  return fraguaName.replace(/:/g, "__");
}

export function unsanitizeToolName(wireName: string): string {
  return wireName.replace(/__/g, ":");
}

interface AdapterDetails {
  fragua_tool: string;
  is_error: boolean;
  data: unknown;
  truncated: boolean;
  original_length: number;
  /** Set when the tool spilled its full output to a host file. */
  full_output_path?: string;
}

function buildContent(
  result: ToolOutput,
  truncationPolicy: Tool["truncation"],
): {
  content: (TextContent | ImageContent)[];
  truncated: boolean;
  originalLength: number;
} {
  // Tool returned rich blocks — forward as-is. Truncation only applies
  // to the text fallback; image blocks are sent verbatim. Tools that
  // emit huge text blocks alongside images are responsible for
  // managing their own size.
  if (result.content && result.content.length > 0) {
    const originalLength = result.content
      .filter((b): b is TextContent => b.type === "text")
      .reduce((acc, b) => acc + b.text.length, 0);
    return { content: result.content, truncated: false, originalLength };
  }
  const truncated = truncate(result.text, truncationPolicy);
  return {
    content: [{ type: "text", text: truncated }],
    truncated: truncated.length !== result.text.length,
    originalLength: result.text.length,
  };
}

export function toAgentTool(fraguaTool: Tool, env: ExecutionEnvironment, fraguaContext?: FraguaToolContext): AgentTool {
  const wireName = sanitizeToolName(fraguaTool.name);
  const agentTool: AgentTool = {
    name: wireName,
    label: fraguaTool.name,
    description: fraguaTool.description,
    parameters: fraguaTool.parameters,
    async execute(
      toolCallId,
      params,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<AdapterDetails>,
    ): Promise<AgentToolResult<AdapterDetails>> {
      const adaptedOnUpdate = onUpdate
        ? (partial: ToolOutput) => {
            const built = buildContent(partial, fraguaTool.truncation);
            const data = partial.data as { full_output_path?: string } | undefined;
            onUpdate({
              content: built.content,
              details: {
                fragua_tool: fraguaTool.name,
                is_error: partial.is_error ?? false,
                data: partial.data,
                truncated: built.truncated,
                original_length: built.originalLength,
                ...(data?.full_output_path ? { full_output_path: data.full_output_path } : {}),
              },
            });
          }
        : undefined;

      // PathEscapeError catch: the env's resolvePath throws when a
      // tool argument references a path outside the run's cwd
      // (Phase 9 leak — agent passed `/Users/bandarra/fragua/.agents/...`
      // while running in a `.fragua/worktrees/<runId>` env). Convert to
      // a tool-error result so the model self-corrects with a relative
      // path on its next turn rather than halting the run.
      let result: ToolOutput;
      try {
        result = await fraguaTool.execute(params as Record<string, unknown>, env, {
          ...(signal ? { signal } : {}),
          ...(adaptedOnUpdate ? { onUpdate: adaptedOnUpdate } : {}),
          ...(fraguaContext ? { fraguaContext } : {}),
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        });
      } catch (err) {
        if (err instanceof PathEscapeError) {
          return {
            content: [{ type: "text", text: err.message }],
            details: {
              fragua_tool: fraguaTool.name,
              is_error: true,
              data: { path: err.path, resolved: err.resolved, cwd: err.cwd },
              truncated: false,
              original_length: err.message.length,
            },
          };
        }
        throw err;
      }
      const built = buildContent(result, fraguaTool.truncation);
      const data = result.data as { full_output_path?: string } | undefined;
      return {
        content: built.content,
        details: {
          fragua_tool: fraguaTool.name,
          is_error: result.is_error ?? false,
          data: result.data,
          truncated: built.truncated,
          original_length: built.originalLength,
          ...(data?.full_output_path ? { full_output_path: data.full_output_path } : {}),
        },
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  };
  if (fraguaTool.prepareArguments) {
    // pi-agent-core invokes prepareArguments before TypeBox validation,
    // so we can hand it the same shim the fragua tool defines.
    agentTool.prepareArguments = fraguaTool.prepareArguments as (input: unknown) => Record<string, unknown>;
  }
  return agentTool;
}

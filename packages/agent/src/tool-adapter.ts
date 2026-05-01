// Convert a swarm Tool into a pi-agent-core AgentTool. The resulting
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
//     swarm `ToolOutput` partials into AgentToolResult partials so
//     the UI can render mid-execution progress.
//   - `content[]`: when a swarm tool returns rich blocks (image read),
//     we forward them verbatim. Otherwise we wrap the truncated
//     `text` in a single TextContent block, preserving prior behaviour.

import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExecutionEnvironment, Tool, ToolOutput } from "@swarm/workspace";
import { truncate } from "@swarm/workspace";

/** Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$` — `:` is rejected.
 * We encode namespaces with `__` on the wire and reverse at event-bridge time
 * for human-readable logs. `__` is safe because swarm tool slugs use single `_`. */
export function sanitizeToolName(swarmName: string): string {
  return swarmName.replace(/:/g, "__");
}

export function unsanitizeToolName(wireName: string): string {
  return wireName.replace(/__/g, ":");
}

interface AdapterDetails {
  swarm_tool: string;
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

export function toAgentTool(swarmTool: Tool, env: ExecutionEnvironment): AgentTool {
  const wireName = sanitizeToolName(swarmTool.name);
  const agentTool: AgentTool = {
    name: wireName,
    label: swarmTool.name,
    description: swarmTool.description,
    parameters: swarmTool.parameters,
    async execute(
      _toolCallId,
      params,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<AdapterDetails>,
    ): Promise<AgentToolResult<AdapterDetails>> {
      const adaptedOnUpdate = onUpdate
        ? (partial: ToolOutput) => {
            const built = buildContent(partial, swarmTool.truncation);
            const data = partial.data as { full_output_path?: string } | undefined;
            onUpdate({
              content: built.content,
              details: {
                swarm_tool: swarmTool.name,
                is_error: partial.is_error ?? false,
                data: partial.data,
                truncated: built.truncated,
                original_length: built.originalLength,
                ...(data?.full_output_path ? { full_output_path: data.full_output_path } : {}),
              },
            });
          }
        : undefined;

      const result = await swarmTool.execute(params as Record<string, unknown>, env, {
        ...(signal ? { signal } : {}),
        ...(adaptedOnUpdate ? { onUpdate: adaptedOnUpdate } : {}),
      });
      const built = buildContent(result, swarmTool.truncation);
      const data = result.data as { full_output_path?: string } | undefined;
      return {
        content: built.content,
        details: {
          swarm_tool: swarmTool.name,
          is_error: result.is_error ?? false,
          data: result.data,
          truncated: built.truncated,
          original_length: built.originalLength,
          ...(data?.full_output_path ? { full_output_path: data.full_output_path } : {}),
        },
      };
    },
  };
  if (swarmTool.prepareArguments) {
    // pi-agent-core invokes prepareArguments before TypeBox validation,
    // so we can hand it the same shim the swarm tool defines.
    agentTool.prepareArguments = swarmTool.prepareArguments as (input: unknown) => Record<string, unknown>;
  }
  return agentTool;
}

// Convert a swarm Tool into a pi-agent-core AgentTool. The resulting AgentTool
// closes over the ExecutionEnvironment so the LLM's tool-call args flow into
// our workspace implementation.

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExecutionEnvironment, Tool } from "@swarm/workspace";
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

export function toAgentTool(swarmTool: Tool, env: ExecutionEnvironment): AgentTool {
  const wireName = sanitizeToolName(swarmTool.name);
  return {
    name: wireName,
    label: swarmTool.name,
    description: swarmTool.description,
    parameters: swarmTool.parameters,
    async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
      const result = await swarmTool.execute(params as Record<string, unknown>, env);
      const truncated = truncate(result.text, swarmTool.truncation);
      // pi-agent-core conventions: throw on failure OR set isError implicitly
      // via the result shape. We encode errors in the content + details so the
      // agent loop surfaces them to the LLM for retry.
      return {
        content: [{ type: "text", text: truncated }],
        details: {
          swarm_tool: swarmTool.name,
          is_error: result.is_error ?? false,
          data: result.data,
          truncated: truncated.length !== result.text.length,
          original_length: result.text.length,
        },
      };
    },
  };
}

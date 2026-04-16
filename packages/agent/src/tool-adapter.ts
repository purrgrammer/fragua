// Convert a swarm Tool into a pi-agent-core AgentTool. The resulting AgentTool
// closes over the ExecutionEnvironment so the LLM's tool-call args flow into
// our workspace implementation.

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExecutionEnvironment, Tool } from "@swarm/workspace";
import { truncate } from "@swarm/workspace";

export function toAgentTool(swarmTool: Tool, env: ExecutionEnvironment): AgentTool {
  return {
    name: swarmTool.name,
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

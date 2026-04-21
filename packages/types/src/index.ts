// @swarm/types — pi-agent-core / pi-ai types used throughout the
// codebase, plus swarm-specific declaration merges. Every package
// that handles messages imports from here instead of directly from
// pi-agent-core so the custom-role merges below apply consistently
// across the TypeScript compile graph.
//
// Why a separate package: TypeScript declaration merging only applies
// to files that are actually part of a compile unit. A merge living
// in @swarm/store won't be visible to @swarm/web unless web's tsc
// pulls store's source into its graph — which it doesn't, since web
// only imports @swarm/core. Putting the merge here and having every
// consumer import from @swarm/types guarantees the merge activates.

export type { AgentMessage, AgentToolCall, AgentToolResult } from "@mariozechner/pi-agent-core";
export type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
export { ALL_EVENT_TYPES, type EventType } from "./events.ts";

export { ALL_EVENT_TYPES, type EventType } from "./events.ts";

/** Swarm-specific custom message type: the assembled system prompt
 * for a single LLM call. Persisted in the `messages` table so UIs
 * and debuggers can reconstruct exactly what the model saw, without
 * hitting the 4KB cap on `llm.start`'s event payload. Filtered back
 * out before feeding priorMessages to pi-ai — pi-ai carries the
 * system prompt separately via `Context.systemPrompt`. */
export interface SystemPromptMessage {
  role: "system";
  content: string;
  timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    system: SystemPromptMessage;
  }
}

// RunConversation — the primary surface of `/runs/:id`.
//
// Renders the run's full transcript from the `messages` table (§I9).
// Each row is a pi-agent-core `AgentMessage`; we iterate
// `content[]` blocks (text, thinking, toolCall) and pair each
// `toolCall` to its matching `toolResult` message by `tool_use_id`.
// Swarm-internal `system` rows (the assembled system prompt) collapse
// by default.
//
// `data-testid` hooks:
//   - `conversation-user-prompt`   — the initial user-input message
//   - `message-<ordinal>`          — one per row
//   - `tool-<toolCallId>`          — one per tool_call
//   - `reasoning-<ordinal>-<idx>`  — one per thinking block
//   - `conversation-empty`         — empty state

import type { AssistantMessage, TextContent, ToolResultMessage } from "@swarm/types";
import { Fragment, type ReactNode, useMemo } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message as AIMessage, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RunMessageRow } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface RunConversationProps {
  messages: RunMessageRow[];
  isLive?: boolean;
  isLoading?: boolean;
  /** Free-form text the run was launched with. Rendered as the first
   * user message at the top. The agent's event stream carries only
   * synthesized `role=user` shells, so the initial prompt lives here. */
  userInput?: string | null;
  className?: string;
}

export function RunConversation({
  messages,
  isLive = false,
  isLoading = false,
  userInput,
  className,
}: RunConversationProps): JSX.Element {
  // Build a toolCallId → result map so each toolCall inside an
  // assistant message can pull in its paired result inline (same
  // convention as pi-mono's Messages.ts `toolResultsById`).
  const toolResultsById = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const row of messages) {
      if (row.content.role === "toolResult") {
        map.set(row.content.toolCallId, row.content);
      }
    }
    return map;
  }, [messages]);

  const visibleMessages = useMemo(
    // toolResult rows are rendered inline with their paired toolCall,
    // not as standalone bubbles.
    () => messages.filter((row) => row.content.role !== "toolResult"),
    [messages],
  );

  const empty = !isLoading && !userInput && visibleMessages.length === 0;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Conversation className="flex-1">
        {empty ? (
          <ConversationContent>
            <ConversationEmptyState
              data-testid="conversation-empty"
              title="No conversation yet"
              description="The agent hasn't produced any messages for this run."
            />
          </ConversationContent>
        ) : (
          <ConversationContent>
            {userInput && <UserPromptMessage text={userInput} />}
            {visibleMessages.map((row) => (
              <MessageRow key={row.ordinal} row={row} toolResultsById={toolResultsById} isLive={isLive} />
            ))}
          </ConversationContent>
        )}
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}

// ─── Message dispatch ──────────────────────────────────────────────

interface MessageRowProps {
  row: RunMessageRow;
  toolResultsById: Map<string, ToolResultMessage>;
  isLive: boolean;
}

function MessageRow({ row, toolResultsById, isLive }: MessageRowProps): JSX.Element | null {
  const msg = row.content;
  const testid = `message-${row.ordinal}`;
  if (msg.role === "system") {
    return <SystemPromptRow content={msg.content} testid={testid} />;
  }
  if (msg.role === "user") {
    return <UserMessageRow message={msg} testid={testid} />;
  }
  if (msg.role === "assistant") {
    return (
      <AssistantMessageRow
        message={msg}
        toolResultsById={toolResultsById}
        ordinal={row.ordinal}
        isLive={isLive}
        testid={testid}
      />
    );
  }
  return null;
}

// ─── Initial user-input message (from run.args) ────────────────────

function UserPromptMessage({ text }: { text: string }): JSX.Element {
  return (
    <AIMessage from="user" data-testid="conversation-user-prompt">
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  );
}

// ─── System prompt (collapsed by default) ──────────────────────────

function SystemPromptRow({ content, testid }: { content: string; testid: string }): JSX.Element {
  return (
    <Collapsible
      data-testid={testid}
      className="group/sysprompt rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 font-mono text-muted-foreground hover:text-foreground">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
        <span>system prompt · {content.length.toLocaleString()} chars</span>
        <span className="ml-auto font-mono text-[10px] opacity-60 transition group-data-[state=open]/sysprompt:rotate-180">
          ▾
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground/80">
        {content}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── User message (pi-ai UserMessage) ──────────────────────────────

function UserMessageRow({
  message,
  testid,
}: {
  message: { content: string | Array<TextContent | { type: string }> };
  testid: string;
}): JSX.Element | null {
  const text = flattenText(message.content);
  if (text.length === 0) return null;
  return (
    <AIMessage from="user" data-testid={testid}>
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </AIMessage>
  );
}

// ─── Assistant message — walks content[] blocks in order ────────────

interface AssistantRowProps {
  message: AssistantMessage;
  toolResultsById: Map<string, ToolResultMessage>;
  ordinal: number;
  isLive: boolean;
  testid: string;
}

function AssistantMessageRow({ message, toolResultsById, ordinal, testid }: AssistantRowProps): JSX.Element | null {
  const blocks: ReactNode[] = [];
  let i = 0;
  for (const chunk of message.content) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        blocks.push(<MessageResponse key={`${ordinal}-t${i}`}>{chunk.text}</MessageResponse>);
      }
    } else if (chunk.type === "thinking") {
      if (chunk.thinking.trim().length > 0) {
        blocks.push(
          <Reasoning key={`${ordinal}-r${i}`} data-testid={`reasoning-${ordinal}-${i}`} className="w-full">
            <ReasoningTrigger />
            <ReasoningContent>{chunk.thinking}</ReasoningContent>
          </Reasoning>,
        );
      }
    } else if (chunk.type === "toolCall") {
      const result = toolResultsById.get(chunk.id);
      blocks.push(
        <Tool key={`${ordinal}-c${i}`} data-testid={`tool-${chunk.id}`}>
          <ToolHeader
            type={toolTypeFromName(chunk.name)}
            state={result ? (result.isError ? "output-error" : "output-available") : "input-available"}
            title={chunk.name}
          />
          <ToolContent>
            <ToolInput input={chunk.arguments} />
            <ToolOutput
              output={result ? flattenText(result.content) : null}
              errorText={result?.isError ? flattenText(result.content) : undefined}
            />
          </ToolContent>
        </Tool>,
      );
    }
    i++;
  }
  if (blocks.length === 0) return null;

  return (
    <AIMessage from="assistant" data-testid={testid}>
      <MessageContent>
        {blocks.map((block, k) => (
          <Fragment key={k}>{block}</Fragment>
        ))}
      </MessageContent>
    </AIMessage>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block != null && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Map a swarm tool name to AI-Elements' `tool-${string}` type
 * identifier. Keeps the Tool component's icon/label conventions. */
function toolTypeFromName(name: string): `tool-${string}` {
  return `tool-${name}` as `tool-${string}`;
}

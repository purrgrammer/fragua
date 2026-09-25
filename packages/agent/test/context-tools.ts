// Test helper: read the advertised tool set and system prompt from the
// normalized request context a provider receives.
//
// pi-ai 0.87.1 moved tool declarations and the system prompt off
// `Context.tools` / `Context.systemPrompt` and into the transcript's leading
// system message (`SystemMessage.toolsAdded` / `.content`). Tests that spy on
// what the model is offered read through these helpers so they assert against
// the shape providers actually see.

import type { Message, Tool } from "@earendil-works/pi-ai";

/** The tools advertised to the provider, in order, gathered from every
 *  system message's `toolsAdded`. */
export function advertisedTools(ctx: { messages: Message[] }): Tool[] {
  return ctx.messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []));
}

/** The concatenated system-prompt text carried by the leading system
 *  message (`content` may be a string or text blocks). */
export function advertisedSystemPrompt(ctx: { messages: Message[] }): string {
  const sys = ctx.messages.find((m) => m.role === "system");
  if (!sys || sys.role !== "system") return "";
  return typeof sys.content === "string" ? sys.content : sys.content.map((c) => c.text).join("");
}

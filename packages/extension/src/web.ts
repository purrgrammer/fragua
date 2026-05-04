// Web-rendering subpath of @swarm/extension. Imported by paired
// `<name>.web.tsx` files; the daemon never imports this module so
// `react` and `lucide-react` peers stay out of the daemon's module
// graph.
//
// All imports here are type-only: a (mistaken) runtime import in
// daemon-loaded code resolves to an empty module without crashing.

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Renderer contract for paired `<name>.web.tsx` files. Either field
 *  is optional; the most common shape is icon-only or render-only.
 *
 *  Resolution chain in ai-elements `<ToolHeader>` / `<ToolContent>`:
 *
 *    icon:    WebRenderer.icon → WrenchIcon
 *    render:  WebRenderer.render → ToolDefinition.renderText (markdown)
 *             → ai-elements default (JSON code block)
 */
export interface WebRenderer<TParams = unknown, TDetails = unknown> {
  /** Optional icon for the ai-elements `<ToolHeader>`. Pass the Lucide
   *  component directly. */
  icon?: LucideIcon;

  /** Optional React renderer. Receives `params` (tool input) and
   *  `result` (the typed tool-result message), plus streaming flags.
   *  `isStreaming` = true while args are still being assembled or the
   *  tool is mid-execution; `isPartial` = true when `result` reflects
   *  a partial update (`onUpdate` callback in the tool's `execute`). */
  render?(
    params: TParams | undefined,
    result: ToolResultMessage<TDetails> | undefined,
    opts: { isStreaming: boolean; isPartial: boolean },
  ): { content: ReactNode; isCustom?: boolean };
}

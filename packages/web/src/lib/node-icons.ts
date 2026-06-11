// Icon language for fragua handler / node types — one lucide glyph per type,
// reused across the Cost breakdown, the graph, and node inspectors so a type
// reads the same everywhere. The icon carries TYPE identity, not run state, so
// render it quiet (`text-sw-muted`) — never with a state accent.

import { Bot, Circle, Flag, type LucideIcon, Play, Split, Terminal, User } from "lucide-react";

const NODE_TYPE_ICONS: Record<string, LucideIcon> = {
  llm: Bot,
  tool: Terminal,
  human: User,
  parallel: Split,
  start: Play,
  exit: Flag,
};

/** The icon for a handler / node type. Unknown or absent types fall back to a
 * neutral dot, so a new node kind renders something rather than crashing. */
export function nodeTypeIcon(type: string | undefined): LucideIcon {
  return (type !== undefined && NODE_TYPE_ICONS[type]) || Circle;
}

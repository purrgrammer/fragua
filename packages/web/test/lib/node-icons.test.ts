// The handler-type icon language must cover every fragua node type, so a row
// in the Cost breakdown / graph never silently mis-labels a type. Unknown or
// absent types fall back to a neutral dot rather than crashing.

import { Bot, Circle, Flag, Play, Split, Terminal, User } from "lucide-react";
import { describe, expect, it } from "vitest";
import { nodeTypeIcon } from "../../src/lib/node-icons.ts";

describe("nodeTypeIcon", () => {
  it("maps every handler type to a distinct glyph", () => {
    expect(nodeTypeIcon("llm")).toBe(Bot);
    expect(nodeTypeIcon("tool")).toBe(Terminal);
    expect(nodeTypeIcon("human")).toBe(User);
    expect(nodeTypeIcon("parallel")).toBe(Split);
    expect(nodeTypeIcon("start")).toBe(Play);
    expect(nodeTypeIcon("exit")).toBe(Flag);
  });

  it("falls back to a neutral dot for unknown or absent types", () => {
    expect(nodeTypeIcon("mystery")).toBe(Circle);
    expect(nodeTypeIcon(undefined)).toBe(Circle);
  });
});

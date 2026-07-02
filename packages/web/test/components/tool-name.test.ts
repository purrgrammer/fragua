// `formatMcpToolName` — MCP tool headers render as "<server> · <method>"
// (dropping the `mcp` namespace), for both the unsanitised `mcp:server:method`
// form the event bridge emits and the `mcp__server__method` wire form.

import { describe, expect, test } from "vitest";
import { formatMcpToolName } from "../../src/components/ai-elements/tool.tsx";

describe("formatMcpToolName", () => {
  test("colon form (event bridge) → server · method", () => {
    expect(formatMcpToolName("mcp:github:search_repositories")).toBe("github · search_repositories");
  });

  test("wire form (double underscore) → server · method", () => {
    expect(formatMcpToolName("mcp__clickup__get_workspace_members")).toBe("clickup · get_workspace_members");
  });

  test("non-MCP names return undefined (caller falls back to the humanizer)", () => {
    expect(formatMcpToolName("bash")).toBeUndefined();
    expect(formatMcpToolName("read")).toBeUndefined();
    expect(formatMcpToolName("mcp")).toBeUndefined();
    expect(formatMcpToolName("mcp:")).toBeUndefined();
  });
});

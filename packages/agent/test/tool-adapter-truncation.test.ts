// The DEFAULT_TRUNCATION fallback in toAgentTool: a fragua tool that
// omits `truncation` (e.g. web_fetch) still gets its text-fallback
// capped, while a tool returning rich `content[]` bypasses truncation
// via buildContent's early exit.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, Tool, ToolOutput } from "@fragua/workspace";
import { Type } from "@sinclair/typebox";
import { toAgentTool } from "../src/tool-adapter.ts";

const env = {} as unknown as ExecutionEnvironment;

function makeTool(output: ToolOutput): Tool {
  return {
    name: "web_fetch_probe",
    description: "probe",
    parameters: Type.Object({}),
    idempotent: true,
    async execute() {
      return output;
    },
  };
}

describe("toAgentTool DEFAULT_TRUNCATION fallback", () => {
  test("caps text output of a tool that omits truncation", async () => {
    // DEFAULT_TRUNCATION.max_chars is 200_000; a longer text with no
    // rich content[] must be trimmed by the fallback policy.
    const text = "x".repeat(300_000);
    const tool = makeTool({ text, content: [] });
    expect(tool.truncation).toBeUndefined();

    const agentTool = toAgentTool(tool, env);
    const res = await agentTool.execute("tc1", {});

    expect(res.details.truncated).toBe(true);
    expect(res.details.original_length).toBe(300_000);
    const block = res.content[0];
    expect(block?.type).toBe("text");
    const rendered = block?.type === "text" ? block.text : "";
    expect(rendered.length).toBeLessThan(210_000);
  });

  test("bypasses truncation when the tool returns populated content[]", async () => {
    const bigText = "y".repeat(300_000);
    const tool = makeTool({ text: "ignored", content: [{ type: "text", text: bigText }] });

    const agentTool = toAgentTool(tool, env);
    const res = await agentTool.execute("tc1", {});

    expect(res.details.truncated).toBe(false);
    const block = res.content[0];
    expect(block?.type).toBe("text");
    const rendered = block?.type === "text" ? block.text : "";
    expect(rendered.length).toBe(300_000);
  });
});

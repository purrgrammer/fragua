// Tests for tool-name sanitization: Anthropic rejects `:` in tool names
// (regex `^[a-zA-Z0-9_-]{1,128}$`), so we encode `local:read_file` as
// `local__read_file` at the pi-agent adapter boundary and reverse it in
// event-bridge so logs stay on the canonical swarm name.

import { describe, expect, test } from "bun:test";
import { bridgeAgentEvent } from "../src/event-bridge.ts";
import { sanitizeToolName, toAgentTool, unsanitizeToolName } from "../src/tool-adapter.ts";

describe("sanitize/unsanitize tool names", () => {
  test("replaces `:` with `__` for the wire", () => {
    expect(sanitizeToolName("local:read_file")).toBe("local__read_file");
    expect(sanitizeToolName("mcp:fs:glob")).toBe("mcp__fs__glob");
    expect(sanitizeToolName("custom:thing")).toBe("custom__thing");
  });

  test("wire names only use the Anthropic-permitted charset", () => {
    const permitted = /^[a-zA-Z0-9_-]{1,128}$/;
    for (const name of ["local:read_file", "local:write_file", "local:bash", "mcp:fs:glob"]) {
      expect(sanitizeToolName(name)).toMatch(permitted);
    }
  });

  test("round-trip restores the swarm-native name", () => {
    for (const name of ["local:read_file", "custom:thing", "mcp:fs:glob"]) {
      expect(unsanitizeToolName(sanitizeToolName(name))).toBe(name);
    }
  });

  test("unsanitize is a no-op on names without `__`", () => {
    expect(unsanitizeToolName("some_pi_internal_tool")).toBe("some_pi_internal_tool");
    expect(unsanitizeToolName("bash")).toBe("bash");
  });
});

describe("toAgentTool — wire-name propagation", () => {
  test("AgentTool.name is sanitized; label keeps the swarm-native form", () => {
    const fakeEnv = {
      cwd: () => "/",
      readFile: async () => "",
      writeFile: async () => {},
      exists: async () => false,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
      listDir: async () => [],
      glob: async () => [],
    };
    const agentTool = toAgentTool(
      {
        name: "local:read_file",
        description: "d",
        // biome-ignore lint/suspicious/noExplicitAny: minimal TSchema stub for the test.
        parameters: { type: "object", properties: {} } as any,
        idempotent: true,
        truncation: { max_chars: 100, mode: "tail" },
        async execute() {
          return { text: "ok" };
        },
      },
      fakeEnv,
    );
    expect(agentTool.name).toBe("local__read_file");
    expect(agentTool.label).toBe("local:read_file");
  });
});

describe("event-bridge — un-sanitizes tool_name for audit log", () => {
  test("tool.execution_start restores the `:` in tool_name", () => {
    const bridged = bridgeAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "local__read_file",
      // biome-ignore lint/suspicious/noExplicitAny: minimal event stub.
      args: {} as any,
    } as never);
    expect(bridged?.data["tool_name"]).toBe("local:read_file");
  });

  test("tool.execution_end restores the `:` in tool_name", () => {
    const bridged = bridgeAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "local__write_file",
      isError: false,
      // biome-ignore lint/suspicious/noExplicitAny: minimal event stub.
      result: {} as any,
    } as never);
    expect(bridged?.data["tool_name"]).toBe("local:write_file");
  });
});

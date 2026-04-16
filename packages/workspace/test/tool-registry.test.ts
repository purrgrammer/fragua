import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { type Tool, ToolRegistry } from "../src/types.ts";

function makeTool(name: string): Tool {
  return {
    name,
    description: "test",
    parameters: Type.Object({}),
    idempotent: true,
    truncation: { max_chars: 1000, mode: "tail" },
    async execute() {
      return { text: "ok" };
    },
  };
}

describe("ToolRegistry", () => {
  test("rejects tools without namespace prefix", () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool("read_file"))).toThrow("namespace prefix");
  });

  test("registers namespaced tool", () => {
    const r = new ToolRegistry();
    r.register(makeTool("local:read_file"));
    expect(r.get("local:read_file")).toBeDefined();
  });

  test("rejects duplicate registration", () => {
    const r = new ToolRegistry();
    r.register(makeTool("local:x"));
    expect(() => r.register(makeTool("local:x"))).toThrow("already registered");
  });

  test("select with allow list", () => {
    const r = new ToolRegistry();
    r.registerAll([makeTool("local:a"), makeTool("local:b"), makeTool("local:c")]);
    const picked = r.select({ allow: ["local:a", "local:c"] });
    expect(picked.map((t) => t.name).sort()).toEqual(["local:a", "local:c"]);
  });

  test("select with deny list", () => {
    const r = new ToolRegistry();
    r.registerAll([makeTool("local:a"), makeTool("local:b")]);
    const picked = r.select({ deny: ["local:b"] });
    expect(picked.map((t) => t.name)).toEqual(["local:a"]);
  });
});

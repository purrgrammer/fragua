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
  test("rejects tool names with namespaces or punctuation", () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool("local:read"))).toThrow("bare identifier");
    expect(() => r.register(makeTool("read-file"))).toThrow("bare identifier");
    expect(() => r.register(makeTool("READ"))).toThrow("bare identifier");
    expect(() => r.register(makeTool("1read"))).toThrow("bare identifier");
  });

  test("registers a bare-identifier tool", () => {
    const r = new ToolRegistry();
    r.register(makeTool("read"));
    expect(r.get("read")).toBeDefined();
  });

  test("rejects duplicate registration", () => {
    const r = new ToolRegistry();
    r.register(makeTool("x"));
    expect(() => r.register(makeTool("x"))).toThrow("already registered");
  });

  test("select with allow list", () => {
    const r = new ToolRegistry();
    r.registerAll([makeTool("a"), makeTool("b"), makeTool("c")]);
    const picked = r.select({ allow: ["a", "c"] });
    expect(picked.map((t) => t.name).sort()).toEqual(["a", "c"]);
  });

  test("select with deny list", () => {
    const r = new ToolRegistry();
    r.registerAll([makeTool("a"), makeTool("b")]);
    const picked = r.select({ deny: ["b"] });
    expect(picked.map((t) => t.name)).toEqual(["a"]);
  });
});

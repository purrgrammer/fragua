import { describe, expect, test } from "bun:test";
import { InMemoryToolRegistry } from "../../src/handler/tool-registry.ts";
import type { ToolDescriptor } from "../../src/handler/types.ts";

function tool(name: string): ToolDescriptor {
  return {
    name,
    sideEffect: "none",
    handler: async () => undefined,
  };
}

describe("InMemoryToolRegistry — select as hard filter", () => {
  test("allow narrows get/has/list to the allowlist; everything else throws unknown", () => {
    const r = new InMemoryToolRegistry();
    r.register(tool("read"));
    r.register(tool("write"));
    r.register(tool("bash"));

    const narrow = r.select({ allow: ["read"] });
    expect(narrow.list()).toEqual(["read"]);
    expect(narrow.has("read")).toBe(true);
    expect(narrow.has("bash")).toBe(false);
    expect(() => narrow.get("bash")).toThrow(/unknown tool: bash/);
    expect(narrow.get("read").name).toBe("read");
  });

  test("deny subtracts from allow; allow:[a,b] + deny:[b] → {a}", () => {
    const r = new InMemoryToolRegistry();
    r.register(tool("a"));
    r.register(tool("b"));
    r.register(tool("c"));
    const narrow = r.select({ allow: ["a", "b"], deny: ["b"] });
    expect(narrow.list()).toEqual(["a"]);
  });

  test("a re-narrowed view is intersection, not union", () => {
    const r = new InMemoryToolRegistry();
    r.register(tool("a"));
    r.register(tool("b"));
    r.register(tool("c"));
    const first = r.select({ allow: ["a", "b"] });
    const second = first.select({ allow: ["b", "c"] });
    expect(second.list()).toEqual(["b"]);
    expect(() => second.get("a")).toThrow();
    expect(() => second.get("c")).toThrow();
  });

  test("narrowed view rejects register() — prevents a handler from smuggling tools in", () => {
    const r = new InMemoryToolRegistry();
    r.register(tool("read"));
    const narrow = r.select({ allow: ["read"] }) as InMemoryToolRegistry;
    expect(() => narrow.register(tool("bash"))).toThrow(/narrowed/);
  });
});

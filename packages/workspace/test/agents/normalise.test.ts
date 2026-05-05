import { describe, expect, test } from "bun:test";
import { normaliseToolName } from "../../src/agents/normalise.ts";

describe("normaliseToolName", () => {
  test("PascalCase → snake_case lowercase (WebFetch → web_fetch)", () => {
    const r = normaliseToolName("WebFetch");
    expect(r.name).toBe("web_fetch");
    expect(r.changed).toBe(true);
  });

  test("Already-canonical names pass through without warning", () => {
    const r = normaliseToolName("read");
    expect(r.name).toBe("read");
    expect(r.changed).toBe(false);
  });

  test("Bare lowercase capitalised words (Read → read)", () => {
    const r = normaliseToolName("Read");
    expect(r.name).toBe("read");
    expect(r.changed).toBe(true);
  });

  test("Multi-segment PascalCase (FooBarBaz → foo_bar_baz)", () => {
    const r = normaliseToolName("FooBarBaz");
    expect(r.name).toBe("foo_bar_baz");
    expect(r.changed).toBe(true);
  });

  test("Already snake_case stays put", () => {
    const r = normaliseToolName("web_fetch");
    expect(r.name).toBe("web_fetch");
    expect(r.changed).toBe(false);
  });
});

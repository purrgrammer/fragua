import { describe, expect, test } from "bun:test";
import { parseAgentMd } from "../../src/agents/parse.ts";

describe("parseAgentMd", () => {
  test("extracts frontmatter + body", () => {
    const raw = `---\nname: rev\ndescription: Review code\nmodel: claude-x\n---\n\nYou are a reviewer.\n\nAlways check tests.`;
    const parsed = parseAgentMd(raw);
    expect(parsed.frontmatter["name"]).toBe("rev");
    expect(parsed.frontmatter["description"]).toBe("Review code");
    expect(parsed.frontmatter["model"]).toBe("claude-x");
    expect(parsed.body.startsWith("You are a reviewer.")).toBe(true);
    expect(parsed.body.includes("Always check tests.")).toBe(true);
    expect(parsed.warnings).toHaveLength(0);
  });

  test("malformed YAML degrades gracefully with a warning", () => {
    const raw = `---\nname: rev\ndescription: Use this when: the diff is small\n---\n\nbody`;
    const parsed = parseAgentMd(raw);
    expect(parsed.frontmatter["name"]).toBe("rev");
    expect(parsed.frontmatter["description"]).toContain("the diff is small");
    expect(parsed.warnings.some((w) => w.includes("repaired"))).toBe(true);
  });

  test("no frontmatter at all yields empty frontmatter + warning", () => {
    const parsed = parseAgentMd("just a body");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe("just a body");
    expect(parsed.warnings).toEqual(["agent .md has no YAML frontmatter"]);
  });
});

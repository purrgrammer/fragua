import { describe, expect, test } from "bun:test";
import { parseSkillMd, stripFrontmatter } from "../../src/skills/parse.ts";

describe("parseSkillMd", () => {
  test("parses valid frontmatter + body", () => {
    const src = `---
name: pdf
description: Extract text from PDFs.
version: 0.1.0
---

# Body

body text`;
    const { frontmatter, body, warnings } = parseSkillMd(src);
    expect(frontmatter["name"]).toBe("pdf");
    expect(frontmatter["description"]).toBe("Extract text from PDFs.");
    expect(frontmatter["version"]).toBe("0.1.0");
    expect(body.startsWith("# Body")).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("repairs unquoted colon in description", () => {
    const src = `---
name: ex
description: Use this skill when: the user asks about PDFs
---

body`;
    const { frontmatter, warnings } = parseSkillMd(src);
    expect(frontmatter["description"]).toBe("Use this skill when: the user asks about PDFs");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("repaired");
  });

  test("missing frontmatter returns empty object with warning", () => {
    const src = "no frontmatter here\n";
    const { frontmatter, body, warnings } = parseSkillMd(src);
    expect(frontmatter).toEqual({});
    expect(body).toBe("no frontmatter here");
    expect(warnings[0]).toContain("no YAML frontmatter");
  });

  test("accepts array allowed_tools", () => {
    const src = `---
name: ex
description: test
allowed_tools:
  - local:read_file
  - local:bash
---

body`;
    const { frontmatter } = parseSkillMd(src);
    expect(frontmatter["allowed_tools"]).toEqual(["local:read_file", "local:bash"]);
  });
});

describe("stripFrontmatter", () => {
  test("removes frontmatter block", () => {
    const src = `---
name: x
description: y
---

# Body`;
    expect(stripFrontmatter(src)).toBe("# Body");
  });

  test("leaves body intact when no frontmatter", () => {
    expect(stripFrontmatter("# Hello")).toBe("# Hello");
  });
});

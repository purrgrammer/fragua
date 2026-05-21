// `skill` tool \u2014 wire-level execute() against a stub env + catalogue.
// Pins the structured `data` payload that drives the UI's Skill card
// (rides on tool.execution_end.data.result.details.data).

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@fragua/core";
import { skillTool } from "../src/skill-tool.ts";
import type { Skill } from "../src/skills/types.ts";
import type { FraguaToolContext } from "../src/types.ts";

function skill(name: string, body: string, extras: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `desc for ${name}`,
    location: `/abs/${name}/SKILL.md`,
    skill_dir: `/abs/${name}`,
    sha256: "a".repeat(64),
    bytes: body.length,
    scope: "user",
    source_dir: "/abs",
    ...extras,
  };
}

function envFor(files: Record<string, string>): ExecutionEnvironment {
  // Tool only reads `readFile`; cast the stub through `unknown` so we
  // don't have to scaffold the rest of the ExecutionEnvironment surface
  // for a unit test.
  return {
    readFile: async (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`ENOENT: ${path}`);
    },
  } as unknown as ExecutionEnvironment;
}

function ctx(catalog: readonly Skill[]): FraguaToolContext {
  // We don't exercise http in these tests — cast through unknown so we
  // don't have to scaffold a full HttpClient.
  return {
    runId: "r",
    nodeId: "n",
    iteration: 0,
    http: {} as never,
    emit: () => {},
    skillCatalog: catalog,
  } as unknown as FraguaToolContext;
}

describe("skill tool", () => {
  test("execute resolves a known skill via fraguaContext.skillCatalog", async () => {
    const md = `---\nname: frontend\ndescription: React patterns\n---\nuse react`;
    const env = envFor({ "/abs/frontend/SKILL.md": md });
    const cat = [skill("frontend", md, { location: "/abs/frontend/SKILL.md", description: "React patterns" })];
    const out = await skillTool.execute({ name: "frontend" }, env, { fraguaContext: ctx(cat) });
    expect(out.is_error).toBeFalsy();
    expect(out.text).toContain("# Skill: frontend");
    expect(out.text).toContain("_React patterns_");
    expect(out.text).toContain("use react");
    expect(out.data).toEqual({
      name: "frontend",
      description: "React patterns",
      path: "/abs/frontend/SKILL.md",
      content: "use react",
    });
  });

  test("execute on a name not in the catalogue returns is_error with available names", async () => {
    const md = `---\nname: a\ndescription: A\n---\nbody-a`;
    const env = envFor({ "/abs/a/SKILL.md": md });
    const cat = [skill("a", md, { location: "/abs/a/SKILL.md" })];
    const out = await skillTool.execute({ name: "z" }, env, { fraguaContext: ctx(cat) });
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("unknown skill");
    expect(out.text).toContain('"z"');
    expect(out.text).toContain("a");
  });

  test("execute when fraguaContext is omitted falls back to is_error with empty-catalogue message", async () => {
    const env = envFor({});
    const out = await skillTool.execute({ name: "x" }, env, {});
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("catalogue is empty");
  });

  test("substitutes arguments and surfaces the substituted body on data.content", async () => {
    const md = `---\nname: x\ndescription: d\n---\nhello $ARGUMENTS`;
    const env = envFor({ "/abs/x/SKILL.md": md });
    const cat = [skill("x", md, { location: "/abs/x/SKILL.md" })];
    const out = await skillTool.execute({ name: "x", arguments: "world" }, env, { fraguaContext: ctx(cat) });
    expect(out.is_error).toBeFalsy();
    expect(out.data?.content).toBe("hello world");
    expect(out.text).toContain("hello world");
  });
});

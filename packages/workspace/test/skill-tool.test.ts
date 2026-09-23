// `skill` tool — wire-level execute() against a real catalogue on disk.
// Pins the structured `data` payload that drives the UI's Skill card
// (rides on tool.execution_end.data.result.details.data), and that the
// tool reads catalogue files where discovery found them — never through
// the run env, whose path gate would refuse anything outside a worktree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/local-env.ts";
import { skillTool } from "../src/skill-tool.ts";
import type { Skill } from "../src/skills/types.ts";
import type { FraguaToolContext } from "../src/types.ts";

let skillsRoot: string;
let runCwd: string;

beforeEach(async () => {
  skillsRoot = await mkdtemp(join(tmpdir(), "fragua-skills-"));
  runCwd = await mkdtemp(join(tmpdir(), "fragua-run-"));
});

afterEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
  await rm(runCwd, { recursive: true, force: true });
});

async function skill(name: string, body: string, extras: Partial<Skill> = {}): Promise<Skill> {
  const dir = join(skillsRoot, name);
  await mkdir(dir, { recursive: true });
  const location = join(dir, "SKILL.md");
  await writeFile(location, body, "utf8");
  return {
    name,
    description: `desc for ${name}`,
    location,
    skill_dir: dir,
    sha256: "a".repeat(64),
    bytes: body.length,
    scope: "project",
    source_dir: skillsRoot,
    ...extras,
  };
}

/** A path-gated env rooted somewhere else — the worktree shape. */
function env(): LocalEnvironment {
  return new LocalEnvironment({ cwd: runCwd });
}

function ctx(catalog: readonly Skill[]): FraguaToolContext {
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
  test("resolves a catalogue skill that lives outside the run's cwd", async () => {
    const md = `---\nname: frontend\ndescription: React patterns\n---\nuse react`;
    const s = await skill("frontend", md, { description: "React patterns" });
    const out = await skillTool.execute({ name: "frontend" }, env(), { fraguaContext: ctx([s]) });
    expect(out.is_error).toBeFalsy();
    expect(out.text).toContain("# Skill: frontend");
    expect(out.text).toContain("_React patterns_");
    expect(out.text).toContain("use react");
    expect(out.data).toEqual({
      name: "frontend",
      description: "React patterns",
      path: s.location,
      content: "use react",
    });
  });

  test("a name not in the catalogue returns is_error with available names", async () => {
    const s = await skill("a", `---\nname: a\ndescription: A\n---\nbody-a`);
    const out = await skillTool.execute({ name: "z" }, env(), { fraguaContext: ctx([s]) });
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("unknown skill");
    expect(out.text).toContain('"z"');
    expect(out.text).toContain("a");
  });

  test("without fraguaContext the catalogue is empty", async () => {
    const out = await skillTool.execute({ name: "x" }, env(), {});
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("catalogue is empty");
  });

  test("a project skill is read from the run's own tree when it carries one", async () => {
    // The worktree shape: the catalogue points at the main checkout, the run
    // works in a copy that has its own (edited) copy of the same skill.
    const s = await skill("local", `---\nname: local\ndescription: d\n---\nmain copy`, {
      scope: "project",
      project_cwd: skillsRoot,
    });
    await mkdir(join(runCwd, "local"), { recursive: true });
    await writeFile(join(runCwd, "local", "SKILL.md"), `---\nname: local\ndescription: d\n---\nworktree copy`, "utf8");
    const out = await skillTool.execute({ name: "local" }, env(), { fraguaContext: ctx([s]) });
    expect(out.is_error).toBeFalsy();
    expect(out.data?.content).toBe("worktree copy");
  });

  test("a project skill the run's tree lacks still loads from the discovery path", async () => {
    const s = await skill("added-later", `---\nname: added-later\ndescription: d\n---\nfrom main`, {
      scope: "project",
      project_cwd: skillsRoot,
    });
    const out = await skillTool.execute({ name: "added-later" }, env(), { fraguaContext: ctx([s]) });
    expect(out.is_error).toBeFalsy();
    expect(out.data?.content).toBe("from main");
  });

  test("substitutes arguments and surfaces the substituted body on data.content", async () => {
    const s = await skill("x", `---\nname: x\ndescription: d\n---\nhello $ARGUMENTS`);
    const out = await skillTool.execute({ name: "x", arguments: "world" }, env(), { fraguaContext: ctx([s]) });
    expect(out.is_error).toBeFalsy();
    expect(out.data?.content).toBe("hello world");
    expect(out.text).toContain("hello world");
  });
});

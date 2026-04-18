import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../../src/local-env.ts";
import { discoverSkills } from "../../src/skills/discover.ts";
import { buildLoadSkillTool } from "../../src/skills/load-tool.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "swarm-load-skill-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeSkill(name: string, body = "body"): Promise<void> {
  const dir = join(tmp, ".swarm/skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`, "utf8");
}

describe("buildLoadSkillTool", () => {
  test("throws when no visible skills", () => {
    expect(() => buildLoadSkillTool([])).toThrow("at least one visible skill");
  });

  test("loads SKILL.md body and lists resources", async () => {
    await writeSkill("hello", "# Hello\n\nInstructions.");
    const scriptDir = join(tmp, ".swarm/skills/hello/scripts");
    await mkdir(scriptDir, { recursive: true });
    await writeFile(join(scriptDir, "run.py"), "print('ok')", "utf8");

    const { skills } = await discoverSkills({ cwd: tmp, homeDir: "" });
    const tool = buildLoadSkillTool(skills);
    const env = new LocalEnvironment({ cwd: tmp });

    const out = await tool.execute({ name: "hello" }, env);
    expect(out.text).toContain('<skill_content name="hello">');
    expect(out.text).toContain("# Hello");
    expect(out.text).toContain("Instructions.");
    expect(out.text).toContain("<skill_resources>");
    expect(out.text).toContain("scripts/run.py");
    expect(out.data?.resources).toContain("scripts/run.py");
  });

  test("returns error for unknown skill name", async () => {
    await writeSkill("only-one");
    const { skills } = await discoverSkills({ cwd: tmp, homeDir: "" });
    const tool = buildLoadSkillTool(skills);
    const env = new LocalEnvironment({ cwd: tmp });

    // Bypass schema enforcement to test runtime fallthrough.
    const out = await tool.execute({ name: "does-not-exist" as "only-one" }, env);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("unknown skill");
  });

  test("strips frontmatter from body", async () => {
    await writeSkill("strip", "Just the body.");
    const { skills } = await discoverSkills({ cwd: tmp, homeDir: "" });
    const tool = buildLoadSkillTool(skills);
    const env = new LocalEnvironment({ cwd: tmp });

    const out = await tool.execute({ name: "strip" }, env);
    expect(out.text).not.toContain("---");
    expect(out.text).not.toContain("description:");
  });

  test("omits <skill_resources> when skill has no resources", async () => {
    await writeSkill("bare");
    const { skills } = await discoverSkills({ cwd: tmp, homeDir: "" });
    const tool = buildLoadSkillTool(skills);
    const env = new LocalEnvironment({ cwd: tmp });

    const out = await tool.execute({ name: "bare" }, env);
    expect(out.text).not.toContain("<skill_resources>");
  });
});

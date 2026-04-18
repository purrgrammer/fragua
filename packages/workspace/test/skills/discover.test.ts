import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "../../src/skills/discover.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "swarm-skills-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeSkill(root: string, dir: string, name: string, description: string, extra = ""): Promise<void> {
  const skillDir = join(root, dir);
  await mkdir(skillDir, { recursive: true });
  const body = `---
name: ${name}
description: ${description}
${extra}
---

# ${name}

body`;
  await writeFile(join(skillDir, "SKILL.md"), body, "utf8");
}

describe("discoverSkills", () => {
  test("discovers skills from .swarm/skills in project scope", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".swarm/skills/hello", "hello", "Greet the user.");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("hello");
    expect(skills[0]!.scope).toBe("project");
    expect(skills[0]!.sha256.length).toBe(64);
    expect(skills[0]!.bytes).toBeGreaterThan(0);
  });

  test("discovers skills from ~/.agents/skills in user scope", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeSkill(home, ".agents/skills/pdf", "pdf", "Handle PDFs.");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe("user");
  });

  test("project scope shadows user scope on name collision", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeSkill(cwd, ".swarm/skills/dup", "dup", "project version");
    await writeSkill(home, ".agents/skills/dup", "dup", "user version");

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.scope).toBe("project");
    expect(skills[0]!.description).toBe("project version");
    expect(warnings.some((w) => w.includes("dup"))).toBe(true);
  });

  test("skips skills without a description", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    const dir = join(cwd, ".swarm/skills/broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: broken\n---\n\nbody`, "utf8");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(0);
  });

  test("explicit paths disables auto-discovery", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeSkill(cwd, ".swarm/skills/default", "default", "would auto-discover");
    await writeSkill(cwd, "vendor/pack", "vendored", "only via explicit path");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { paths: ["vendor"] },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("vendored");
  });

  test("disabled config hides from catalog but skill is still discovered", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".swarm/skills/legacy", "legacy", "old skill");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { disabled: ["legacy"] },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.disabled_reason).toContain("skills.disabled");
  });

  test("trust_project=false hides project-scope skills but discovers them", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/untrusted", "untrusted", "vendored by repo");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { trust_project: false },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.disabled_reason).toContain("trust_project");
  });

  test("trust_project defaults to true (no disabled_reason)", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/ok", "ok", "project skill");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.disabled_reason).toBeUndefined();
  });
});

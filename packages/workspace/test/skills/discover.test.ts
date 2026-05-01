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
  test("discovers skills from .agents/skills in project scope", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/hello", "hello", "Greet the user.");

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
    await writeSkill(cwd, ".agents/skills/dup", "dup", "project version");
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
    const dir = join(cwd, ".agents/skills/broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: broken\n---\n\nbody`, "utf8");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(0);
  });

  test("explicit paths disables auto-discovery", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeSkill(cwd, ".agents/skills/default", "default", "would auto-discover");
    await writeSkill(cwd, "vendor/pack", "vendored", "only via explicit path");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { paths: ["vendor"] },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("vendored");
  });

  test("disabled config drops skills entirely from discovery", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/legacy", "legacy", "old skill");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { disabled: ["legacy"] },
    });
    expect(skills).toEqual([]);
  });

  test("trustProject=false hides project-scope skills but discovers them", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/untrusted", "untrusted", "vendored by repo");

    const { skills } = await discoverSkills({
      cwd,
      homeDir: home,
      config: { trustProject: false },
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.disabled_reason).toContain("trustProject");
  });

  test("trustProject defaults to true (no disabled_reason)", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/ok", "ok", "project skill");

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.disabled_reason).toBeUndefined();
  });

  test("parses license / compatibility / metadata frontmatter", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(
      cwd,
      ".agents/skills/full",
      "full",
      "fully-specified skill",
      `license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"`,
    );

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.license).toBe("Apache-2.0");
    expect(s.compatibility).toBe("Requires Python 3.14+ and uv");
    expect(s.metadata).toEqual({ author: "example-org", version: "1.0" });
  });

  test("allowed-tools (kebab) with space-separated string per spec", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/k", "k", "kebab spec form", `allowed-tools: Bash(git:*) Bash(jq:*) Read`);

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills[0]!.allowed_tools).toEqual(["Bash(git:*)", "Bash(jq:*)", "Read"]);
  });

  test("allowed_tools (snake) with array still works for back-compat", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(
      cwd,
      ".agents/skills/s",
      "s",
      "snake legacy form",
      `allowed_tools:
  - read
  - bash`,
    );

    const { skills } = await discoverSkills({ cwd, homeDir: home });
    expect(skills[0]!.allowed_tools).toEqual(["read", "bash"]);
  });

  test("warns when both allowed-tools and allowed_tools are set, prefers spec key", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(
      cwd,
      ".agents/skills/dup",
      "dup",
      "both forms set",
      `allowed-tools: Read Write
allowed_tools:
  - bash`,
    );

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills[0]!.allowed_tools).toEqual(["Read", "Write"]);
    expect(warnings.some((w) => w.includes("allowed-tools") && w.includes("allowed_tools"))).toBe(true);
  });

  test("warns when frontmatter name does not match parent directory", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/parent-dir", "different-name", "mismatched");

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("different-name");
    expect(warnings.some((w) => w.includes("does not match directory"))).toBe(true);
  });

  test("warns on name shape violations but still loads", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    // Uppercase + leading hyphen + consecutive hyphens — three violations.
    await writeSkill(cwd, ".agents/skills/Bad--Name", "Bad--Name", "shape violations");

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1); // still loaded
    expect(warnings.some((w) => w.includes("violates spec charset"))).toBe(true);
  });

  test("warns when name length exceeds 64 chars", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    const longName = "a".repeat(70);
    await writeSkill(cwd, `.agents/skills/${longName}`, longName, "long name");

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(warnings.some((w) => w.includes("exceeds 64 chars"))).toBe(true);
  });

  test("warns when description exceeds 1024 chars", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    const longDesc = "x".repeat(1100);
    await writeSkill(cwd, ".agents/skills/wordy", "wordy", longDesc);

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(warnings.some((w) => w.includes("description") && w.includes("exceeds 1024"))).toBe(true);
  });

  test("warns when body exceeds 500 lines", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    const skillDir = join(cwd, ".agents/skills/long-body");
    await mkdir(skillDir, { recursive: true });
    const big = `---
name: long-body
description: too long
---

${Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n")}`;
    await writeFile(join(skillDir, "SKILL.md"), big, "utf8");

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(warnings.some((w) => w.includes("soft cap"))).toBe(true);
  });

  test("warns when compatibility exceeds 500 chars", async () => {
    const cwd = tmp;
    const home = join(tmp, "home");
    const longCompat = "y".repeat(600);
    await writeSkill(cwd, ".agents/skills/cc", "cc", "ok", `compatibility: ${longCompat}`);

    const { skills, warnings } = await discoverSkills({ cwd, homeDir: home });
    expect(skills).toHaveLength(1);
    expect(warnings.some((w) => w.includes("compatibility") && w.includes("exceeds 500"))).toBe(true);
  });
});

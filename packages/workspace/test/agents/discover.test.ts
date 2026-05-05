import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../../src/agents/discover.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "swarm-agents-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeAgent(root: string, rel: string, body: string): Promise<string> {
  const dir = join(root, rel.replace(/\/[^/]+$/, ""));
  await mkdir(dir, { recursive: true });
  const path = join(root, rel);
  await writeFile(path, body, "utf8");
  return path;
}

function fm(name: string, description: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}\n---\n\nbody for ${name}`;
}

describe("discoverAgents", () => {
  test("scans .agents/agents and .claude/agents under project + user roots", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeAgent(cwd, ".agents/agents/alpha.md", fm("alpha", "p-alpha"));
    await writeAgent(cwd, ".claude/agents/beta.md", fm("beta", "p-beta"));
    await writeAgent(home, ".agents/agents/gamma.md", fm("gamma", "u-gamma"));
    await writeAgent(home, ".claude/agents/delta.md", fm("delta", "u-delta"));

    const { agents } = await discoverAgents({ cwd, homeDir: home });
    const byName = new Map(agents.map((a) => [a.name, a]));
    expect(byName.get("alpha")?.scope).toBe("project");
    expect(byName.get("beta")?.scope).toBe("project");
    expect(byName.get("gamma")?.scope).toBe("user");
    expect(byName.get("delta")?.scope).toBe("user");
    expect(agents).toHaveLength(4);
  });

  test("project beats user on name collision", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeAgent(cwd, ".agents/agents/dup.md", fm("dup", "project"));
    await writeAgent(home, ".agents/agents/dup.md", fm("dup", "user"));

    const { agents, warnings } = await discoverAgents({ cwd, homeDir: home });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.scope).toBe("project");
    expect(agents[0]!.description).toBe("project");
    expect(warnings.some((w) => w.includes("dup"))).toBe(true);
  });

  test("within a scope, .agents/agents wins over .claude/agents", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    await writeAgent(cwd, ".agents/agents/dup.md", fm("dup", "agents-dir"));
    await writeAgent(cwd, ".claude/agents/dup.md", fm("dup", "claude-dir"));

    const { agents, warnings } = await discoverAgents({ cwd, homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.description).toBe("agents-dir");
    expect(warnings.some((w) => w.includes("dup"))).toBe(true);
  });

  test("missing description is skipped with a warning", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/broken.md", `---\nname: broken\n---\n\nbody`);
    const { agents, warnings } = await discoverAgents({ cwd, homeDir: "" });
    expect(agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
  });

  test("missing name is skipped with a warning", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/anon.md", `---\ndescription: hi\n---\n\nbody`);
    const { agents, warnings } = await discoverAgents({ cwd, homeDir: "" });
    expect(agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes("name"))).toBe(true);
  });

  test("name must match filename stem; mismatch emits a warning but does not skip", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/filename.md", fm("other", "desc"));
    const { agents, warnings } = await discoverAgents({ cwd, homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("other");
    expect(warnings.some((w) => w.includes("does not match filename stem"))).toBe(true);
  });

  test("non-canonical allowed_tools entries are normalised and warned", async () => {
    const cwd = tmp;
    await writeAgent(
      cwd,
      ".agents/agents/reviewer.md",
      fm("reviewer", "code review", "allowed_tools: [Read, WebFetch]"),
    );
    const { agents, warnings } = await discoverAgents({ cwd, homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.allowed_tools).toEqual(["read", "web_fetch"]);
    expect(warnings.filter((w) => w.includes("normalised")).length).toBe(2);
  });

  test("missing scope directories are silently ignored", async () => {
    const cwd = join(tmp, "nope");
    const home = join(tmp, "alsono");
    const { agents, warnings } = await discoverAgents({ cwd, homeDir: home });
    expect(agents).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("disabled config drops profiles before precedence merge", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/keep.md", fm("keep", "yes"));
    await writeAgent(cwd, ".agents/agents/drop.md", fm("drop", "no"));
    const { agents } = await discoverAgents({ cwd, homeDir: "", config: { disabled: ["drop"] } });
    expect(agents.map((a) => a.name)).toEqual(["keep"]);
  });
});

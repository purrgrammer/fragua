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

    const { agents } = await discoverAgents({ projectCwds: [cwd], homeDir: home });
    const byName = new Map(agents.map((a) => [a.name, a]));
    expect(byName.get("alpha")?.scope).toBe("project");
    expect(byName.get("beta")?.scope).toBe("project");
    expect(byName.get("gamma")?.scope).toBe("user");
    expect(byName.get("delta")?.scope).toBe("user");
    expect(agents).toHaveLength(4);
  });

  test("project + user collisions coexist in the superset (filter resolves at codergen time)", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await mkdir(cwd, { recursive: true });
    await writeAgent(cwd, ".agents/agents/dup.md", fm("dup", "project"));
    await writeAgent(home, ".agents/agents/dup.md", fm("dup", "user"));

    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: home });
    // Both records present — cross-scope shadowing happens per-run, not at discovery.
    expect(agents).toHaveLength(2);
    const byScope = new Map(agents.map((a) => [a.scope, a]));
    expect(byScope.get("project")?.description).toBe("project");
    expect(byScope.get("project")?.project_cwd).toBe(cwd);
    expect(byScope.get("user")?.description).toBe("user");
    expect(byScope.get("user")?.project_cwd).toBeUndefined();
    // Within-scope shadowing still runs — no warning here because each
    // scope only had one record. Just sanity check no spurious warnings.
    expect(warnings.filter((w) => w.includes("dup"))).toHaveLength(0);
  });

  test("within a scope, .agents/agents wins over .claude/agents", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    await writeAgent(cwd, ".agents/agents/dup.md", fm("dup", "agents-dir"));
    await writeAgent(cwd, ".claude/agents/dup.md", fm("dup", "claude-dir"));

    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.description).toBe("agents-dir");
    expect(warnings.some((w) => w.includes("dup"))).toBe(true);
  });

  test("missing description is skipped with a warning", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/broken.md", `---\nname: broken\n---\n\nbody`);
    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
    expect(agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
  });

  test("missing name is skipped with a warning", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/anon.md", `---\ndescription: hi\n---\n\nbody`);
    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
    expect(agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes("name"))).toBe(true);
  });

  test("name must match filename stem; mismatch emits a warning but does not skip", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/filename.md", fm("other", "desc"));
    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
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
    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.allowed_tools).toEqual(["read", "web_fetch"]);
    expect(warnings.filter((w) => w.includes("normalised")).length).toBe(2);
  });

  test("Claude-Code-style `tools:` frontmatter is accepted as a synonym for `allowed_tools`", async () => {
    // AGENTS.md advertises `.claude/agents/` as a cross-client fallback.
    // Profiles authored for Claude Code use `tools: Read, Write, Edit, ...`
    // (not swarm's canonical `allowed_tools:`); honour them so the
    // explicit-required check on the `agent` tool passes without
    // forcing every Claude-Code profile to be edited.
    const cwd = tmp;
    await writeAgent(
      cwd,
      ".claude/agents/backend-architect.md",
      fm("backend-architect", "design backends", "tools: Read, Write, Edit, Bash, Grep"),
    );
    const { agents } = await discoverAgents({ projectCwds: [cwd], homeDir: "" });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.allowed_tools).toEqual(["read", "write", "edit", "bash", "grep"]);
  });

  test("missing scope directories are silently ignored", async () => {
    const cwd = join(tmp, "nope");
    const home = join(tmp, "alsono");
    const { agents, warnings } = await discoverAgents({ projectCwds: [cwd], homeDir: home });
    expect(agents).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("disabled config drops profiles before precedence merge", async () => {
    const cwd = tmp;
    await writeAgent(cwd, ".agents/agents/keep.md", fm("keep", "yes"));
    await writeAgent(cwd, ".agents/agents/drop.md", fm("drop", "no"));
    const { agents } = await discoverAgents({ projectCwds: [cwd], homeDir: "", config: { disabled: ["drop"] } });
    expect(agents.map((a) => a.name)).toEqual(["keep"]);
  });

  test("multi-project: same agent name in two projects coexists, distinguished by project_cwd", async () => {
    const projA = join(tmp, "projA");
    const projB = join(tmp, "projB");
    await writeAgent(projA, ".agents/agents/reviewer.md", fm("reviewer", "A's reviewer"));
    await writeAgent(projB, ".agents/agents/reviewer.md", fm("reviewer", "B's reviewer"));

    const { agents } = await discoverAgents({ projectCwds: [projA, projB], homeDir: "" });
    expect(agents).toHaveLength(2);
    const byCwd = new Map(agents.map((a) => [a.project_cwd, a]));
    expect(byCwd.get(projA)?.description).toBe("A's reviewer");
    expect(byCwd.get(projB)?.description).toBe("B's reviewer");
  });

  test("non-existent project paths are silently skipped", async () => {
    const realProj = join(tmp, "real");
    const fakeProj = join(tmp, "missing");
    await writeAgent(realProj, ".agents/agents/here.md", fm("here", "real"));

    const { agents, warnings } = await discoverAgents({
      projectCwds: [realProj, fakeProj],
      homeDir: "",
    });
    expect(agents.map((a) => a.name)).toEqual(["here"]);
    expect(warnings.filter((w) => w.includes(fakeProj))).toHaveLength(0);
  });

  test("empty projectCwds with homeDir set → user-scope only", async () => {
    const home = join(tmp, "home");
    await writeAgent(home, ".agents/agents/u.md", fm("u", "user-only"));

    const { agents } = await discoverAgents({ projectCwds: [], homeDir: home });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.scope).toBe("user");
    expect(agents[0]!.project_cwd).toBeUndefined();
  });
});

// HTTP route coverage for the skills surface

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
import { skillsRoutes } from "../../src/store/skills-routes.ts";

let store: SqliteStore;
let tmp: string;
let server: { fetch: (req: Request) => Response | Promise<Response> };

beforeEach(async () => {
  store = new SqliteStore({ path: ":memory:" });
  tmp = await mkdtemp(join(tmpdir(), "swarm-skills-routes-"));
});

afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

async function writeSkill(root: string, dirRel: string, name: string, description: string): Promise<string> {
  const skillDir = join(root, dirRel);
  await mkdir(skillDir, { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description}\n---\n\nbody`;
  await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
  return skillDir;
}

async function writeRaw(root: string, rel: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

function get(path: string): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://test${path}`, { method: "GET" })));
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function build(opts: { cwd: string; homeDir: string }): void {
  server = skillsRoutes({ store, cwd: opts.cwd, homeDir: opts.homeDir });
}

describe("GET /skills", () => {
  test("returns metadata for project + user scope skills with locId", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await writeSkill(cwd, ".agents/skills/frontend", "frontend", "React patterns");
    await writeSkill(home, ".agents/skills/pdf", "pdf", "PDF helpers");
    build({ cwd, homeDir: home });

    const res = await get("/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; scope: string; locId: string }> };
    const names = body.skills.map((s) => s.name).sort();
    expect(names).toEqual(["frontend", "pdf"]);
    for (const s of body.skills) expect(s.locId.length).toBeGreaterThan(0);
  });

  test("?project_cwd=<cwd> scopes to globals + that one project", async () => {
    const projA = join(tmp, "projA");
    const projB = join(tmp, "projB");
    const home = join(tmp, "home");
    await writeSkill(projA, ".agents/skills/aOnly", "aOnly", "from A");
    await writeSkill(projB, ".agents/skills/bOnly", "bOnly", "from B");
    await writeSkill(home, ".agents/skills/global", "global", "user");
    // The ?project_cwd= filter walks discovery against that cwd
    // directly — no need to seed store.listCwds() to make B
    // "discoverable", because the filter bypasses the enumeration.
    build({ cwd: projA, homeDir: home });

    const res = await get(`/skills?project_cwd=${encodeURIComponent(projA)}`);
    const body = (await res.json()) as { skills: Array<{ name: string; project_cwd?: string; scope: string }> };
    const names = body.skills.map((s) => s.name).sort();
    // Only A's project skill + the global; B's bOnly is excluded.
    expect(names).toEqual(["aOnly", "global"]);
  });

  test("?project_cwd=<cwd>&scope=project_only excludes user-scope and other projects", async () => {
    const projA = join(tmp, "projA");
    const projB = join(tmp, "projB");
    const home = join(tmp, "home");
    await writeSkill(projA, ".agents/skills/aOnly", "aOnly", "from A");
    await writeSkill(projB, ".agents/skills/bOnly", "bOnly", "from B");
    await writeSkill(home, ".agents/skills/global", "global", "user");
    build({ cwd: projA, homeDir: home });

    const res = await get(`/skills?project_cwd=${encodeURIComponent(projA)}&scope=project_only`);
    const body = (await res.json()) as { skills: Array<{ name: string; project_cwd?: string; scope: string }> };
    const names = body.skills.map((s) => s.name).sort();
    // user-scope `global` and other-project `bOnly` both dropped.
    expect(names).toEqual(["aOnly"]);
    for (const s of body.skills) {
      expect(s.scope).toBe("project");
      expect(s.project_cwd).toBe(projA);
    }
  });

  test("returns empty list when nothing is discovered", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get("/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: unknown[] };
    expect(body.skills).toEqual([]);
  });
});

describe("GET /skills/:locId", () => {
  test("returns frontmatter + body of SKILL.md", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/frontend", "frontend", "React patterns");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skill: { name: string };
      frontmatter: Record<string, unknown>;
      body: string;
    };
    expect(body.skill.name).toBe("frontend");
    expect(body.frontmatter["name"]).toBe("frontend");
    expect(body.frontmatter["description"]).toBe("React patterns");
    expect(body.body).toBe("body");
  });

  test("404 for unknown locId", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url("/nope")}`);
    expect(res.status).toBe(404);
  });

  test("malformed locId resolves cleanly to 404 (not 500)", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/!!!not-base64!!!`);
    expect(res.status).toBe(404);
  });

  test("b64url round-trips paths with spaces / non-ASCII", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/spaced-name", "spaced-name", "ok");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}`);
    expect(res.status).toBe(200);
  });
});

describe("GET /skills/:locId/tree", () => {
  test("returns recursive tree under skill_dir", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/python", "python", "py helpers");
    await writeRaw(dir, "scripts/util.py", "print('ok')\n");
    await writeRaw(dir, "references/notes.md", "# notes");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: Array<{ path: string; type: string; size: number }> };
    const paths = body.tree.map((e) => e.path).sort();
    expect(paths).toContain("SKILL.md");
    expect(paths).toContain("scripts");
    expect(paths).toContain("scripts/util.py");
    expect(paths).toContain("references");
    expect(paths).toContain("references/notes.md");
    // Sizes are non-zero for files, zero for dirs.
    const skillMd = body.tree.find((e) => e.path === "SKILL.md");
    expect(skillMd?.type).toBe("file");
    expect(skillMd?.size).toBeGreaterThan(0);
    const scripts = body.tree.find((e) => e.path === "scripts");
    expect(scripts?.type).toBe("dir");
  });
});

describe("GET /skills/:locId/file", () => {
  test("returns SKILL.md bytes with text/markdown content type", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/python", "python", "py helpers");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file?path=SKILL.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("name: python");
    expect(text).toContain("body");
  });

  test("returns binary bytes for image with image/png content type", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/visual", "visual", "ok");
    // Tiny PNG header — enough to verify mime dispatch.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeRaw(dir, "assets/hero.png", png);
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file?path=assets/hero.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x89);
    expect(buf[3]).toBe(0x47);
  });

  test("rejects ../ path escape with 403", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/locked", "locked", "ok");
    // Drop a sibling file outside the skill_dir to confirm the sandbox
    // is what's blocking us — not just file-not-found.
    const sibling = join(cwd, ".agents/skills/secret.txt");
    await writeFile(sibling, "secret", "utf8");
    build({ cwd, homeDir: join(tmp, "home") });

    // ../secret.txt resolves to the sibling — must be forbidden.
    const res = await get(`/skills/${b64url(dir)}/file?path=${encodeURIComponent("../secret.txt")}`);
    expect(res.status).toBe(403);
  });

  test("rejects absolute path that escapes skill_dir with 403", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/locked", "locked", "ok");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file?path=${encodeURIComponent("/etc/passwd")}`);
    expect(res.status).toBe(403);
  });

  test("missing path query returns 400", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/locked", "locked", "ok");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file`);
    expect(res.status).toBe(400);
  });

  test("missing file under skill_dir returns 404", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/locked", "locked", "ok");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file?path=does-not-exist.md`);
    expect(res.status).toBe(404);
  });

  test("path pointing at a directory returns 400", async () => {
    const cwd = join(tmp, "proj");
    const dir = await writeSkill(cwd, ".agents/skills/locked", "locked", "ok");
    await mkdir(join(dir, "scripts"), { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/skills/${b64url(dir)}/file?path=scripts`);
    expect(res.status).toBe(400);
  });
});

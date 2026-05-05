// HTTP route coverage for the agents (sub-agent profiles) surface
// (proposal: docs/proposals/skills-and-agents-ui.md).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
import { agentsRoutes } from "../../src/store/agents-routes.ts";

let store: SqliteStore;
let tmp: string;
let server: { fetch: (req: Request) => Response | Promise<Response> };

beforeEach(async () => {
  store = new SqliteStore({ path: ":memory:" });
  tmp = await mkdtemp(join(tmpdir(), "swarm-agents-routes-"));
});

afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

async function writeAgent(root: string, dirRel: string, name: string, description: string): Promise<string> {
  const dir = join(root, dirRel);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  const md = `---\nname: ${name}\ndescription: ${description}\n---\n\nbody for ${name}`;
  await writeFile(path, md, "utf8");
  return path;
}

function get(path: string): Promise<Response> {
  return Promise.resolve(server.fetch(new Request(`http://test${path}`, { method: "GET" })));
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function build(opts: { cwd: string; homeDir: string }): void {
  server = agentsRoutes({ store, cwd: opts.cwd, homeDir: opts.homeDir });
}

describe("GET /agents", () => {
  test("returns metadata + locId for project + user scope profiles", async () => {
    const cwd = join(tmp, "proj");
    const home = join(tmp, "home");
    await writeAgent(cwd, ".agents/agents", "reviewer", "Reviews diffs.");
    await writeAgent(home, ".agents/agents", "researcher", "Reads docs.");
    build({ cwd, homeDir: home });

    const res = await get("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ name: string; scope: string; locId: string }> };
    const names = body.agents.map((a) => a.name).sort();
    expect(names).toEqual(["researcher", "reviewer"]);
    for (const a of body.agents) expect(a.locId.length).toBeGreaterThan(0);
  });

  test("?project_cwd=<cwd> scopes to globals + that one project", async () => {
    const projA = join(tmp, "projA");
    const projB = join(tmp, "projB");
    const home = join(tmp, "home");
    await writeAgent(projA, ".agents/agents", "aReviewer", "A's reviewer");
    await writeAgent(projB, ".agents/agents", "bReviewer", "B's reviewer");
    await writeAgent(home, ".agents/agents", "globalReviewer", "global");
    build({ cwd: projA, homeDir: home });

    const res = await get(`/agents?project_cwd=${encodeURIComponent(projA)}`);
    const body = (await res.json()) as { agents: Array<{ name: string }> };
    const names = body.agents.map((a) => a.name).sort();
    // Only A's project profile + the global; B's bReviewer excluded.
    expect(names).toEqual(["aReviewer", "globalReviewer"]);
  });
});

describe("GET /agents/:locId", () => {
  test("returns metadata + body verbatim", async () => {
    const cwd = join(tmp, "proj");
    const path = await writeAgent(cwd, ".agents/agents", "reviewer", "Reviews diffs.");
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/agents/${b64url(path)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { name: string; description: string }; body: string };
    expect(body.agent.name).toBe("reviewer");
    expect(body.agent.description).toBe("Reviews diffs.");
    expect(body.body).toBe("body for reviewer");
  });

  test("404 for unknown locId", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/agents/${b64url("/nope/missing.md")}`);
    expect(res.status).toBe(404);
  });

  test("malformed locId resolves cleanly to 404 (not 500)", async () => {
    const cwd = join(tmp, "proj");
    await mkdir(cwd, { recursive: true });
    build({ cwd, homeDir: join(tmp, "home") });

    const res = await get(`/agents/!!!not-base64!!!`);
    expect(res.status).toBe(404);
  });
});

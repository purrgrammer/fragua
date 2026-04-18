// GET /skills + GET /skills/:name route coverage.
//
// Exercises the route through createServer with an in-memory SkillReader so
// the tests don't touch the filesystem, plus a smoke test of the disk-backed
// adapter (createDiscoverSkillReader) over a tmp dir.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { createDiscoverSkillReader, createServer } from "../src/index.ts";
import type { RunReader, SkillDetail, SkillReader, SkillSummary } from "../src/ports.ts";

function memorySkillReader(items: SkillSummary[], bodies: Record<string, string> = {}): SkillReader {
  return {
    async list(): Promise<SkillSummary[]> {
      return [...items];
    },
    async read(name: string): Promise<SkillDetail | undefined> {
      const hit = items.find((s) => s.name === name);
      if (!hit) return undefined;
      return { ...hit, body: bodies[name] ?? "" };
    },
  };
}

function memoryRunReader(events: Record<string, Event[]>): RunReader {
  return {
    async listRuns() {
      return Object.keys(events);
    },
    async readEvents(runId: string) {
      return events[runId];
    },
  };
}

function mkSummary(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} skill`,
    location: `/abs/${name}/SKILL.md`,
    skill_dir: `/abs/${name}`,
    sha256: "a".repeat(64),
    bytes: 100,
    scope: "user",
    source_dir: "/abs",
    ...overrides,
  };
}

describe("GET /skills", () => {
  test("returns the reader's list", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { skillReader: memorySkillReader([mkSummary("pdf"), mkSummary("csv")]) },
    });
    const res = await app.request("/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillSummary[];
    expect(body.map((s) => s.name).sort()).toEqual(["csv", "pdf"]);
  });

  test("forwards ?refresh=1 to the reader", async () => {
    let refreshed = false;
    const reader: SkillReader = {
      async list(opts) {
        if (opts?.refresh) refreshed = true;
        return [];
      },
      async read() {
        return undefined;
      },
    };
    const app = createServer({ runsDir: "/unused", ports: { skillReader: reader } });
    await app.request("/skills?refresh=1");
    expect(refreshed).toBe(true);
  });

  test("surfaces disabled_reason in the response", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: {
        skillReader: memorySkillReader([mkSummary("hidden", { disabled_reason: "because" })]),
      },
    });
    const body = (await (await app.request("/skills")).json()) as SkillSummary[];
    expect(body[0]?.disabled_reason).toBe("because");
  });
});

describe("GET /skills/:name", () => {
  test("returns summary + body", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: {
        skillReader: memorySkillReader([mkSummary("pdf")], { pdf: "# PDF\n\ninstructions" }),
      },
    });
    const res = await app.request("/skills/pdf");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SkillDetail;
    expect(body.name).toBe("pdf");
    expect(body.body).toContain("instructions");
  });

  test("404 on unknown name", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { skillReader: memorySkillReader([]) },
    });
    const res = await app.request("/skills/nope");
    expect(res.status).toBe(404);
  });

  test("includes usage when runReader returns load_skill activations", async () => {
    const events: Record<string, Event[]> = {
      "run-a": [
        {
          run_id: "run-a",
          type: "tool.execution_start" as Event["type"],
          timestamp: "2026-04-18T00:00:00Z",
          workflow_sha: "x",
          data: { tool_name: "local:load_skill", args: { name: "pdf" } },
        },
      ],
      "run-b": [
        {
          run_id: "run-b",
          type: "node.started" as Event["type"],
          timestamp: "2026-04-18T00:00:00Z",
          workflow_sha: "x",
          data: {},
        },
      ], // no load_skill
    };
    const app = createServer({
      runsDir: "/unused",
      ports: {
        skillReader: memorySkillReader([mkSummary("pdf")], { pdf: "body" }),
        runReader: memoryRunReader(events),
      },
    });
    const body = (await (await app.request("/skills/pdf")).json()) as SkillDetail & {
      usage?: { runs: string[]; count: number };
    };
    expect(body.usage).toEqual({ runs: ["run-a"], count: 1 });
  });
});

describe("createDiscoverSkillReader", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "swarm-skills-server-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("discovers skills from the cwd and strips frontmatter on read()", async () => {
    const dir = join(tmp, ".agents/skills/hello");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: hello\ndescription: Greeting\n---\n\n# Hello\n\nbody", "utf8");
    const reader = createDiscoverSkillReader({ cwd: tmp, homeDir: "" });
    const list = await reader.list();
    expect(list.map((s) => s.name)).toEqual(["hello"]);
    const detail = await reader.read("hello");
    expect(detail?.body).toContain("# Hello");
    expect(detail?.body).not.toContain("---");
  });

  test("refresh bypasses the cache", async () => {
    // First list is empty; after adding a skill, `refresh:true` picks it up.
    const reader = createDiscoverSkillReader({ cwd: tmp, homeDir: "", cacheTtlMs: 60_000 });
    expect(await reader.list()).toEqual([]);
    const dir = join(tmp, ".agents/skills/late");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: late\ndescription: arrived later\n---\n\nbody", "utf8");
    expect(await reader.list()).toEqual([]); // still cached
    const fresh = await reader.list({ refresh: true });
    expect(fresh.map((s) => s.name)).toEqual(["late"]);
  });
});

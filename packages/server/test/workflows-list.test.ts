// GET /workflows — returns the list produced by the injected WorkflowReader.
//
// We exercise both the route (through createServer) and the fs adapter in
// one file because the surface is small and the two halves share fixtures.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWorkflowReader, createServer } from "../src/index.ts";
import type { WorkflowReader, WorkflowSummary } from "../src/ports.ts";

function memoryWorkflowReader(items: WorkflowSummary[]): WorkflowReader {
  return {
    async list(): Promise<WorkflowSummary[]> {
      return [...items];
    },
    async read(): Promise<undefined> {
      return undefined;
    },
  };
}

describe("GET /workflows", () => {
  test("returns 200 and [] when no workflows exist", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { workflowReader: memoryWorkflowReader([]) },
    });
    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(0);
  });

  test("emits name, path, sha, optional label for each workflow", async () => {
    const items: WorkflowSummary[] = [
      { name: "a", path: "workflows/a.dot", sha: "abc1234", label: "Alpha" },
      { name: "b", path: "workflows/b.dot", sha: "def5678" },
    ];
    const app = createServer({
      runsDir: "/unused",
      ports: { workflowReader: memoryWorkflowReader(items) },
    });
    const res = await app.request("/workflows");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkflowSummary[];
    expect(body.length).toBe(2);
    expect(body[0]).toEqual({ name: "a", path: "workflows/a.dot", sha: "abc1234", label: "Alpha" });
    expect(body[1]).toEqual({ name: "b", path: "workflows/b.dot", sha: "def5678" });
  });
});

describe("createFsWorkflowReader", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-wf-"));
    await writeFile(
      join(dir, "alpha.dot"),
      'digraph alpha {\n  graph [ label = "Alpha workflow" ]\n  start [shape=Mdiamond]\n}\n',
      "utf8",
    );
    await writeFile(join(dir, "beta.dot"), "digraph beta {\n  start [shape=Mdiamond]\n}\n", "utf8");
    // Non-dot files must be ignored.
    await writeFile(join(dir, "README.md"), "not a workflow\n", "utf8");
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("scans *.dot files, computes short sha, extracts label, sorts by name", async () => {
    const reader = createFsWorkflowReader({ workflowsDir: dir });
    const list = await reader.list();
    expect(list.length).toBe(2);
    expect(list[0]?.name).toBe("alpha");
    expect(list[1]?.name).toBe("beta");
    expect(list[0]?.label).toBe("Alpha workflow");
    expect(list[1]?.label).toBeUndefined();
    for (const w of list) {
      expect(w.sha).toMatch(/^[0-9a-f]{7}$/);
      expect(w.path.endsWith(".dot")).toBe(true);
    }
  });

  test("returns [] for a missing directory (no throw)", async () => {
    const reader = createFsWorkflowReader({ workflowsDir: join(dir, "does-not-exist") });
    const list = await reader.list();
    expect(list).toEqual([]);
  });
});


describe("GET /workflows/:name", () => {
  test("returns 200 + full detail (summary + source) when the workflow exists", async () => {
    const detail = {
      name: "alpha",
      path: "workflows/alpha.dot",
      sha: "abc1234",
      label: "Alpha",
      source: "digraph alpha {\n  start [shape=Mdiamond]\n}\n",
    };
    const app = createServer({
      runsDir: "/unused",
      ports: {
        workflowReader: {
          async list() {
            return [{ name: detail.name, path: detail.path, sha: detail.sha, label: detail.label }];
          },
          async read(name: string) {
            return name === detail.name ? detail : undefined;
          },
        },
      },
    });
    const res = await app.request("/workflows/alpha");
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof detail;
    expect(body).toEqual(detail);
  });

  test("returns 404 when the workflow is unknown", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: {
        workflowReader: {
          async list() {
            return [];
          },
          async read() {
            return undefined;
          },
        },
      },
    });
    const res = await app.request("/workflows/does-not-exist");
    expect(res.status).toBe(404);
  });
});

describe("createFsWorkflowReader.read", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-wf-read-"));
    await writeFile(
      join(dir, "alpha.dot"),
      'digraph alpha {\n  graph [ label = "Alpha workflow" ]\n  start [shape=Mdiamond]\n}\n',
      "utf8",
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("returns the full DOT source plus summary metadata", async () => {
    const reader = createFsWorkflowReader({ workflowsDir: dir });
    const detail = await reader.read("alpha");
    expect(detail).toBeDefined();
    expect(detail?.name).toBe("alpha");
    expect(detail?.label).toBe("Alpha workflow");
    expect(detail?.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(detail?.source).toContain("digraph alpha");
    expect(detail?.source).toContain("Mdiamond");
  });

  test("returns undefined for an unknown workflow (no throw)", async () => {
    const reader = createFsWorkflowReader({ workflowsDir: dir });
    const detail = await reader.read("does-not-exist");
    expect(detail).toBeUndefined();
  });

  test("rejects names containing a path separator", async () => {
    const reader = createFsWorkflowReader({ workflowsDir: dir });
    expect(await reader.read("../etc/passwd")).toBeUndefined();
    expect(await reader.read("sub/alpha")).toBeUndefined();
    expect(await reader.read(".alpha")).toBeUndefined();
    expect(await reader.read("")).toBeUndefined();
  });
});

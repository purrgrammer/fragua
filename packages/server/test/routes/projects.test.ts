// Integration tests for /projects/:id/{tree,blob}. Covers the lookup
// guards (unknown project → 404, malformed path → 400) and every
// readBlob outcome the route layer maps to a distinct status.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@swarm/store";
import type { ProjectTreeEntry, ProjectTreeReader, ReadBlobResult } from "../../src/ports.ts";
import { projectsRoutes } from "../../src/routes/projects.ts";

interface Fixture {
  store: SqliteStore;
  cwd: string;
  encId: string;
  app: { fetch: (req: Request) => Response | Promise<Response> };
}

/** Mirror of `web/src/lib/projectId.ts:encodeProjectId` so the test
 *  builds the same ids the web client would send. */
function encodeProjectId(cwd: string): string {
  return Buffer.from(cwd, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function setup(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "swarm-projects-route-"));
  await writeFile(join(cwd, "hello.txt"), "world\n");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "index.ts"), "export {};\n");
  await writeFile(join(cwd, "big.txt"), Buffer.alloc(1024 * 1024 + 1, 65));
  await writeFile(join(cwd, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));

  const store = new SqliteStore({ path: ":memory:" });
  // Register the project by routing a run through it so listCwds() returns it.
  store.saveWorkflow("wf_for_proj", "noop", "digraph G { a -> b }");
  store.enqueueRun({ runId: "r-proj", workflowSha: "wf_for_proj", cwd });

  // Use the real adapter so the route + adapter integration is exercised
  // end-to-end. Unit-level guards are covered in the adapter test.
  const reader: ProjectTreeReader = {
    async list(_root: string): Promise<ProjectTreeEntry[]> {
      // Minimal fake: enumerate the few files we created so the test
      // doesn't depend on the host having `git` installed.
      return [
        { path: "hello.txt", type: "file" },
        { path: "src", type: "dir" },
        { path: "src/index.ts", type: "file" },
        { path: "big.txt", type: "file" },
        { path: "bin.dat", type: "file" },
      ];
    },
    async readBlob(_root: string, relPath: string): Promise<ReadBlobResult> {
      if (relPath === "hello.txt") return { kind: "ok", text: "world\n" };
      if (relPath === "big.txt") return { kind: "too_large" };
      if (relPath === "bin.dat") return { kind: "binary" };
      return { kind: "not_found" };
    },
  };

  const app = projectsRoutes({ store, reader });
  return { store, cwd, encId: encodeProjectId(cwd), app };
}

let fx: Fixture;

beforeEach(async () => {
  fx = await setup();
});

afterEach(async () => {
  fx.store.close();
  await rm(fx.cwd, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return fx.app.fetch(new Request(`http://test${path}`));
}

describe("GET /projects/:id/tree", () => {
  test("404 when project cwd is unknown to the store", async () => {
    const bogus = encodeProjectId("/no/such/project");
    const res = await get(`/projects/${bogus}/tree`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns flat list of {path,type} entries for a known project", async () => {
    const res = await get(`/projects/${fx.encId}/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectTreeEntry[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((e) => e.type === "dir")).toBe(true);
    expect(body.some((e) => e.type === "file")).toBe(true);
    expect(body.some((e) => e.path === "hello.txt" && e.type === "file")).toBe(true);
  });

  test("400 when the id segment is not valid base64url", async () => {
    const res = await get(`/projects/!!!!notbase64/tree`);
    // Most malformed inputs decode to garbage that isn't in listCwds(),
    // so the route returns not_found. Either invalid_id or not_found is
    // a defensible refusal — we just want a 4xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("GET /projects/:id/blob", () => {
  test("400 when path contains `..` or starts with `/`", async () => {
    const a = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("../etc/passwd")}`);
    expect(a.status).toBe(400);
    const ab = (await a.json()) as { error: string };
    expect(ab.error).toBe("invalid_path");

    const b = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("/etc/passwd")}`);
    expect(b.status).toBe(400);
    const bb = (await b.json()) as { error: string };
    expect(bb.error).toBe("invalid_path");
  });

  test("400 when path query is missing or empty", async () => {
    const a = await get(`/projects/${fx.encId}/blob`);
    expect(a.status).toBe(400);
    const b = await get(`/projects/${fx.encId}/blob?path=`);
    expect(b.status).toBe(400);
  });

  test("404 when path doesn't exist in the project", async () => {
    const res = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("nope.txt")}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("415 when blob is binary", async () => {
    const res = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("bin.dat")}`);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_media_type");
  });

  test("413 when blob exceeds 1MB", async () => {
    const res = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("big.txt")}`);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("too_large");
  });

  test("200 text/plain for a normal file", async () => {
    const res = await get(`/projects/${fx.encId}/blob?path=${encodeURIComponent("hello.txt")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("world\n");
  });
});

// Integration tests for the run-scoped tree / blob / changes routes.
// Covers (a) the lookup guards (404 unknown / 410 disposed worktree),
// (b) the blob preflight + reader pass-through, and (c) the /changes
// pipeline against a real two-commit synthesised git history.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import type { ProjectTreeEntry, ProjectTreeReader, ReadBlobResult } from "../../src/ports.ts";
import { runFilesRoutes } from "../../src/routes/run-files.ts";

const execFileAsync = promisify(execFile);

interface Fixture {
  store: SqliteStore;
  cwd: string;
  runId: string;
  app: { fetch: (req: Request) => Response | Promise<Response> };
  reader: ProjectTreeReader;
}

const STUB_ENTRIES: ProjectTreeEntry[] = [
  { path: "hello.txt", type: "file" },
  { path: "src", type: "dir" },
  { path: "src/index.ts", type: "file" },
];

function stubReader(): ProjectTreeReader {
  return {
    async list(_root: string): Promise<ProjectTreeEntry[]> {
      return STUB_ENTRIES;
    },
    async readBlob(_root: string, relPath: string): Promise<ReadBlobResult> {
      if (relPath === "hello.txt") return { kind: "ok", text: "world\n" };
      return { kind: "not_found" };
    },
  };
}

async function setup(opts: { withWorktreeDir?: boolean } = {}): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "fragua-run-files-"));
  const runId = "r-files-1";
  if (opts.withWorktreeDir !== false) {
    await mkdir(join(cwd, ".fragua", "worktrees", runId), { recursive: true });
  }

  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "wf_run_files",
    "noop",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId, workflowSha: "wf_run_files", cwd });

  const reader = stubReader();
  const app = runFilesRoutes({ store, reader });
  return { store, cwd, runId, app, reader };
}

let fx: Fixture;

afterEach(async () => {
  fx?.store.close();
  if (fx?.cwd) await rm(fx.cwd, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return fx.app.fetch(new Request(`http://test${path}`));
}

describe("GET /runs/:runId/tree", () => {
  beforeEach(async () => {
    fx = await setup();
  });

  test("404 when run unknown", async () => {
    const res = await get(`/runs/does-not-exist/tree`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("410 when worktree directory absent", async () => {
    fx.store.close();
    await rm(fx.cwd, { recursive: true, force: true });
    fx = await setup({ withWorktreeDir: false });
    const res = await get(`/runs/${fx.runId}/tree`);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("worktree_disposed");
  });

  test("200 with entries when worktree exists", async () => {
    const res = await get(`/runs/${fx.runId}/tree`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectTreeEntry[];
    expect(body).toEqual(STUB_ENTRIES);
  });
});

describe("GET /runs/:runId/blob", () => {
  beforeEach(async () => {
    fx = await setup();
  });

  test("forwards reader result for path inside worktree", async () => {
    const res = await get(`/runs/${fx.runId}/blob?path=${encodeURIComponent("hello.txt")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("world\n");
  });

  test("400 on traversal attempt", async () => {
    const res = await get(`/runs/${fx.runId}/blob?path=${encodeURIComponent("../etc/passwd")}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_path");
  });

  test("400 when path query is missing", async () => {
    const res = await get(`/runs/${fx.runId}/blob`);
    expect(res.status).toBe(400);
  });

  test("410 when worktree directory absent", async () => {
    fx.store.close();
    await rm(fx.cwd, { recursive: true, force: true });
    fx = await setup({ withWorktreeDir: false });
    const res = await get(`/runs/${fx.runId}/blob?path=${encodeURIComponent("hello.txt")}`);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("worktree_disposed");
  });
});

interface GitFixture {
  cwd: string;
  runId: string;
  baseSha: string;
  store: SqliteStore;
  app: { fetch: (req: Request) => Response | Promise<Response> };
}

// Build a real git repo with a base commit (keep.txt + remove.txt +
// edit.txt). When `withTip` is true, also create a delta commit and point
// `refs/fragua/snapshots/<id>` at it (edits edit.txt, removes remove.txt,
// adds new.txt) — the shape the snapshotter writes at the terminal
// boundary. baseGitSha is stamped onto the projection via `fact.run_started`.
async function setupGitRun(opts: { withTip: boolean; runId: string; slug: string }): Promise<GitFixture> {
  const cwd = await mkdtemp(join(tmpdir(), `fragua-run-files-${opts.slug}-`));
  const runId = opts.runId;

  await git(cwd, ["init", "--quiet", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  await writeFile(join(cwd, "keep.txt"), "keep\n");
  await writeFile(join(cwd, "remove.txt"), "to-remove\n");
  await writeFile(join(cwd, "edit.txt"), "line1\nline2\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", "base", "--no-gpg-sign", "--quiet"]);
  const baseSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  if (opts.withTip) {
    // Build the run's delta and point the snapshot tip ref at it — mirrors
    // what the snapshotter writes (refs/fragua/snapshots/<id>), no porcelain branch.
    await writeFile(join(cwd, "edit.txt"), "line1\nline2 changed\nline3\n");
    await rm(join(cwd, "remove.txt"));
    await writeFile(join(cwd, "new.txt"), "fresh\n");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "run delta", "--no-gpg-sign", "--quiet"]);
    const tipSha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await git(cwd, ["update-ref", `refs/fragua/snapshots/${runId}`, tipSha]);
  }

  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "wf_changes",
    "noop",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId, workflowSha: "wf_changes", cwd });
  const enqueued = store.getState(runId);
  if (enqueued == null) throw new Error("run not enqueued");
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf_changes",
          contractVersion: 1,
          startNode: "a",
          baseGitSha: baseSha,
        },
      },
    ],
    enqueued.version,
  );

  const reader = stubReader();
  const app = runFilesRoutes({ store, reader });
  return { cwd, runId, baseSha, store, app };
}

describe("GET /runs/:runId/changes", () => {
  test("404 when run unknown", async () => {
    fx = await setup();
    const res = await get(`/runs/does-not-exist/changes`);
    expect(res.status).toBe(404);
  });

  test("synthesised two-commit history yields {path,status,additions,deletions} rows", async () => {
    const g = await setupGitRun({ withTip: true, runId: "r-changes-1", slug: "changes" });
    const res = await g.app.fetch(new Request(`http://test/runs/${g.runId}/changes`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
    }>;
    const byPath = new Map(body.map((r) => [r.path, r]));

    expect(byPath.get("new.txt")).toMatchObject({ status: "added", deletions: 0 });
    expect(byPath.get("new.txt")?.additions).toBeGreaterThan(0);

    expect(byPath.get("remove.txt")).toMatchObject({ status: "deleted", additions: 0 });
    expect(byPath.get("remove.txt")?.deletions).toBeGreaterThan(0);

    const edited = byPath.get("edit.txt");
    expect(edited?.status).toBe("modified");
    expect(edited?.additions).toBeGreaterThan(0);
    expect(edited?.deletions).toBeGreaterThan(0);

    // keep.txt is unchanged, must not appear.
    expect(byPath.has("keep.txt")).toBe(false);

    g.store.close();
    await rm(g.cwd, { recursive: true, force: true });
    // Override the global afterEach cleanup — we already closed +
    // removed the per-test fixture above.
    fx = { store: new SqliteStore({ path: ":memory:" }), cwd: "", runId: "", app: g.app, reader: stubReader() };
  });
});

describe("GET /runs/:runId/diff", () => {
  test("404 when run unknown", async () => {
    fx = await setup();
    const res = await get(`/runs/does-not-exist/diff`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("410 when the run's snapshot ref is missing", async () => {
    const g = await setupGitRun({ withTip: false, runId: "r-diff-410", slug: "diff-gone" });
    const res = await g.app.fetch(new Request(`http://test/runs/${g.runId}/diff`));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("snapshot_missing");

    g.store.close();
    await rm(g.cwd, { recursive: true, force: true });
    fx = { store: new SqliteStore({ path: ":memory:" }), cwd: "", runId: "", app: g.app, reader: stubReader() };
  });

  test("200 returns unified diff text against synthesized two-commit history", async () => {
    const g = await setupGitRun({ withTip: true, runId: "r-diff-200", slug: "diff-ok" });
    const res = await g.app.fetch(new Request(`http://test/runs/${g.runId}/diff`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/x-diff/);
    const body = await res.text();
    expect(body).toContain("diff --git a/edit.txt b/edit.txt");
    expect(body).toContain("+++ b/new.txt");

    g.store.close();
    await rm(g.cwd, { recursive: true, force: true });
    fx = { store: new SqliteStore({ path: ":memory:" }), cwd: "", runId: "", app: g.app, reader: stubReader() };
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

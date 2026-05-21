// MultiSourceWorkflowReader: aggregates a global `~/.fragua/workflows`
// directory plus every project root the store has ever seen
// (`store.listCwds()` → `<cwd>/.fragua/workflows`). The cwd field on
// each entry tells the listing surface which source owns the workflow;
// `read(name, { cwd })` resolves a single source explicitly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { createMultiSourceWorkflowReader } from "../src/adapters/multi-source-workflow-reader.ts";

interface Fixture {
  root: string;
  globalDir: string;
  projectAlpha: string;
  projectBeta: string;
  store: SqliteStore;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "fragua-multi-wf-"));
  const globalDir = join(root, "global", ".fragua", "workflows");
  const projectAlpha = join(root, "alpha");
  const projectBeta = join(root, "beta");
  await mkdir(globalDir, { recursive: true });
  await mkdir(join(projectAlpha, ".fragua", "workflows"), { recursive: true });
  await mkdir(join(projectBeta, ".fragua", "workflows"), { recursive: true });

  await writeFile(
    join(globalDir, "shared.yaml"),
    "name: shared\ndescription: Global shared\nsteps:\n  work: {type: llm, prompt: x}\n",
  );
  await writeFile(
    join(projectAlpha, ".fragua", "workflows", "alpha-only.yaml"),
    "name: aonly\nsteps:\n  work: {type: llm, prompt: x}\n",
  );
  await writeFile(
    join(projectBeta, ".fragua", "workflows", "beta-only.yaml"),
    "name: bonly\nsteps:\n  work: {type: llm, prompt: x}\n",
  );
  // Name collision across sources: `shared` exists globally + in alpha.
  await writeFile(
    join(projectAlpha, ".fragua", "workflows", "shared.yaml"),
    "name: shared\nsteps:\n  work: {type: llm, prompt: x}\n",
  );

  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf_sha_test", "noop", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
  store.enqueueRun({ runId: "r1", workflowSha: "wf_sha_test", cwd: projectAlpha });
  store.enqueueRun({ runId: "r2", workflowSha: "wf_sha_test", cwd: projectBeta });

  return { root, globalDir, projectAlpha, projectBeta, store };
}

describe("MultiSourceWorkflowReader", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await setup();
  });
  afterEach(async () => {
    fx.store.close();
    await rm(fx.root, { recursive: true, force: true });
  });

  test("list() merges global + every project from store.listCwds()", async () => {
    const reader = createMultiSourceWorkflowReader({ store: fx.store, globalDir: fx.globalDir });
    const list = await reader.list();
    // 1 global + 2 alpha (alpha-only, shared) + 1 beta (beta-only).
    expect(list).toHaveLength(4);
    const byKey = new Map(list.map((w) => [`${w.cwd ?? ""}::${w.name}`, w]));
    expect(byKey.get("::shared")?.cwd).toBeUndefined();
    expect(byKey.get(`${fx.projectAlpha}::alpha-only`)?.cwd).toBe(fx.projectAlpha);
    expect(byKey.get(`${fx.projectAlpha}::shared`)?.cwd).toBe(fx.projectAlpha);
    expect(byKey.get(`${fx.projectBeta}::beta-only`)?.cwd).toBe(fx.projectBeta);
  });

  test("read(name) without cwd prefers global over projects", async () => {
    const reader = createMultiSourceWorkflowReader({ store: fx.store, globalDir: fx.globalDir });
    const detail = await reader.read("shared");
    expect(detail).toBeDefined();
    expect(detail?.cwd).toBeUndefined();
    expect(detail?.source).toContain("Global shared");
  });

  test("read(name, { cwd }) pins lookup to a specific project", async () => {
    const reader = createMultiSourceWorkflowReader({ store: fx.store, globalDir: fx.globalDir });
    const detail = await reader.read("shared", { cwd: fx.projectAlpha });
    expect(detail).toBeDefined();
    expect(detail?.cwd).toBe(fx.projectAlpha);
    expect(detail?.source).toContain("name: shared");
  });

  test('read(name, { cwd: "" }) pins lookup to the global source', async () => {
    const reader = createMultiSourceWorkflowReader({ store: fx.store, globalDir: fx.globalDir });
    const detail = await reader.read("shared", { cwd: "" });
    expect(detail?.cwd).toBeUndefined();
    expect(detail?.source).toContain("Global shared");
  });

  test("extraCwds shows the harness cwd before any run lands in listCwds", async () => {
    // Fresh store: no enqueued runs → no cwds in listCwds. extraCwds
    // should still surface the harness's own project workflows.
    const emptyStore = new SqliteStore({ path: ":memory:" });
    try {
      const reader = createMultiSourceWorkflowReader({
        store: emptyStore,
        globalDir: fx.globalDir,
        extraCwds: [fx.projectAlpha],
      });
      const list = await reader.list();
      const names = new Set(list.map((w) => `${w.cwd ?? ""}::${w.name}`));
      expect(names.has(`${fx.projectAlpha}::alpha-only`)).toBe(true);
    } finally {
      emptyStore.close();
    }
  });

  test("read(name, { cwd }) returns undefined when the project lacks the workflow", async () => {
    const reader = createMultiSourceWorkflowReader({ store: fx.store, globalDir: fx.globalDir });
    const detail = await reader.read("alpha-only", { cwd: fx.projectBeta });
    expect(detail).toBeUndefined();
  });

  test("missing global directory yields project-only listings (no throw)", async () => {
    const reader = createMultiSourceWorkflowReader({
      store: fx.store,
      globalDir: join(fx.root, "does-not-exist"),
    });
    const list = await reader.list();
    expect(list.every((w) => w.cwd !== undefined)).toBe(true);
    expect(list).toHaveLength(3);
  });
});

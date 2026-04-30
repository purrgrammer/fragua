// Behaviour of the `projects` display cache. Source of truth is each
// project's `.swarm/config.jsonc`; this table is denormalized so the UI
// can label runs without filesystem access. Refreshed on every
// `enqueueRun({ projectId, projectName })` call — last-runner wins.

import { describe, expect, test } from "bun:test";
import { freshStore, nextId, seedWorkflow } from "./helpers.ts";

const ID_A = "019de01e-5ccd-7010-9184-defb237e74db";
const ID_B = "019de01e-5ccd-7010-9184-defb237e74dc";

describe("projects table", () => {
  test("enqueueRun with projectId + projectName upserts a row", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({
      runId: nextId(),
      workflowSha: sha,
      projectId: ID_A,
      projectName: "swarm",
      projectRoot: "/Users/me/swarm",
    });
    const row = store.getProject(ID_A);
    expect(row?.name).toBe("swarm");
    expect(row?.rootPath).toBe("/Users/me/swarm");
    store.close();
  });

  test("a second enqueue with a renamed name overwrites the row (last-runner wins)", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_A, projectName: "old-name" });
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_A, projectName: "renamed" });
    expect(store.getProject(ID_A)?.name).toBe("renamed");
    store.close();
  });

  test("enqueueRun without projectId does not insert a row", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: nextId(), workflowSha: sha });
    expect(store.listProjects()).toEqual([]);
    store.close();
  });

  test("enqueueRun with projectId but no projectName skips the upsert", async () => {
    // Projects rows must always have a name (NOT NULL) — the daemon
    // refuses to fabricate a placeholder. Caller is expected to send a
    // name (CLI uses cfg.name ?? basename(cwd)).
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_A });
    expect(store.getProject(ID_A)).toBeNull();
    store.close();
  });

  test("projectRoot may be null even when name is set (CI / mocks)", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_A, projectName: "swarm" });
    const row = store.getProject(ID_A);
    expect(row?.name).toBe("swarm");
    expect(row?.rootPath).toBeNull();
    store.close();
  });

  test("listProjects orders by updatedAt DESC then id ASC", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    // ID_A enqueued first (older updatedAt)
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_A, projectName: "alpha" });
    store.enqueueRun({ runId: nextId(), workflowSha: sha, projectId: ID_B, projectName: "beta" });
    const list = store.listProjects();
    expect(list.map((p) => p.id)).toEqual([ID_B, ID_A]);
    store.close();
  });

  test("upsertProject (public method) inserts and updates outside the enqueue path", async () => {
    const store = freshStore();
    store.upsertProject({ id: ID_A, name: "swarm" });
    expect(store.getProject(ID_A)?.name).toBe("swarm");
    store.upsertProject({ id: ID_A, name: "renamed", rootPath: "/elsewhere" });
    const row = store.getProject(ID_A);
    expect(row?.name).toBe("renamed");
    expect(row?.rootPath).toBe("/elsewhere");
    store.close();
  });
});

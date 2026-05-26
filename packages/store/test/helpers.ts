import { newRunId, SqliteStore } from "../src/index.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });

let seq = 0;

export function freshStore(nowStart = 1_700_000_000_000): SqliteStore {
  let t = nowStart;
  return new SqliteStore({
    path: ":memory:",
    now: () => t++,
  });
}

export function nextId(prefix = "run"): string {
  return `${prefix}_${++seq}`;
}

export async function seedWorkflow(store: SqliteStore, sha = "wf_sha_1"): Promise<string> {
  store.saveWorkflow(sha, "test", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
  return sha;
}

export async function seedRun(
  store: SqliteStore,
  opts: { runId?: string; workflowSha?: string; priority?: number } = {},
): Promise<string> {
  const runId = opts.runId ?? newRunId(); // real ULID — what every production run has (import validates the shape)
  const sha = opts.workflowSha ?? (await seedWorkflow(store));
  store.enqueueRun({
    runId,
    workflowSha: sha,
    priority: opts.priority ?? 0,
  });
  return runId;
}

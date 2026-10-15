import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { newRunId, SqliteStore, sha256Hex } from "../src/index.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });

let seq = 0;

export function freshStore(nowStart = 1_700_000_000_000): SqliteStore {
  let t = nowStart;
  return new SqliteStore({
    path: ":memory:",
    now: () => t++,
  });
}

/** Two stores on one file-backed DB and one blob directory — two processes'
 * view of the same store (e.g. a CLI enqueue next to the harness's GC). */
export function twoStoresOnOneFile(nowStart = 1_700_000_000_000): {
  a: SqliteStore;
  b: SqliteStore;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "fragua-two-stores-"));
  const path = join(dir, "fragua.db");
  let t = nowStart;
  const now = () => t++;
  const a = new SqliteStore({ path, now });
  const b = new SqliteStore({ path, now });
  return {
    a,
    b,
    dispose: () => {
      a.close();
      b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function nextId(prefix = "run"): string {
  return `${prefix}_${++seq}`;
}

export async function seedWorkflow(store: SqliteStore, sha = "wf_sha_1"): Promise<string> {
  store.saveWorkflow(sha, "test", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
  return sha;
}

/** The source a {@link seedHashedWorkflow} row carries for `tag`. */
export function hashedWorkflowSource(tag = "a"): string {
  return `name: t-${tag}\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n`;
}

/** Save a content-addressed workflow (sha = sha256(source), IR parsed from
 *  source) — the only shape bundle import accepts. Distinct `tag`s yield
 *  distinct shas. */
export async function seedHashedWorkflow(store: SqliteStore, tag = "a"): Promise<string> {
  const source = hashedWorkflowSource(tag);
  const sha = sha256Hex(source);
  store.saveWorkflow(sha, "test", source, serializeGraph(parseWorkflow(source)), CURRENT_IR_VERSION);
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

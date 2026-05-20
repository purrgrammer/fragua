// Multi-source WorkflowReader: aggregates `*.yaml` files from the global
// workflows directory (`~/.swarm/workflows/`) plus every project root the
// store has ever seen (`store.listCwds()` → `<cwd>/.swarm/workflows/`).
//
// The CLI's `swarm run` already resolves names against the same two
// sources (global first, then project-local). The web UI used to scan
// only one directory bound at server-startup time, so per-project
// workflows like `<project>/.swarm/workflows/crowdin-review.yaml` were
// invisible. This adapter closes that gap.
//
// Each entry on the wire carries a `cwd` field — `undefined` for the
// global source, a string for a project. Names may collide across
// sources (two projects can both define `change`), so the listing surface
// shows the cwd as a column and the detail endpoint accepts an optional
// `?cwd=…` query param to disambiguate. Lookup precedence when `cwd` is
// not supplied: global → projects in `listCwds()` order (most-recent
// activity first); first hit wins.

import type { IEventStore } from "@swarm/store";
import type { WorkflowDetail, WorkflowReader, WorkflowReadOptions, WorkflowSummary } from "../ports.ts";
import { createFsWorkflowReader } from "./fs-workflow-reader.ts";

export interface MultiSourceWorkflowReaderOptions {
  store: IEventStore;
  /** Global workflows directory. Convention: `~/.swarm/workflows`. */
  globalDir: string;
  /** Optional extra project roots to always include even if absent from
   *  `listCwds()`. Used by the harness to surface its own cwd before any
   *  run has been enqueued from it. Order is preserved; duplicates are
   *  removed. */
  extraCwds?: readonly string[];
}

export function createMultiSourceWorkflowReader(opts: MultiSourceWorkflowReaderOptions): WorkflowReader {
  const { store, globalDir } = opts;
  const extraCwds = opts.extraCwds ?? [];

  const globalReader = createFsWorkflowReader({ workflowsDir: globalDir });

  function projectReader(cwd: string): WorkflowReader {
    return createFsWorkflowReader({ workflowsDir: `${cwd}/.swarm/workflows` });
  }

  // Project ordering used by both list() and the unscoped read() fallback:
  // most-recent activity first (matches `listCwds`), with the harness's
  // own extras appended at the tail in declaration order. Dedupes against
  // the store's set so the same cwd never enumerates twice.
  function projectCwds(): string[] {
    const fromStore = store.listCwds().map((r) => r.cwd);
    const seen = new Set(fromStore);
    const out = [...fromStore];
    for (const cwd of extraCwds) {
      if (seen.has(cwd)) continue;
      seen.add(cwd);
      out.push(cwd);
    }
    return out;
  }

  return {
    async list(): Promise<WorkflowSummary[]> {
      const out: WorkflowSummary[] = [];
      for (const item of await globalReader.list()) out.push(item);
      for (const cwd of projectCwds()) {
        const items = await projectReader(cwd).list();
        for (const item of items) out.push({ ...item, cwd });
      }
      return out;
    },

    async read(name: string, readOpts?: WorkflowReadOptions): Promise<WorkflowDetail | undefined> {
      const requestedCwd = readOpts?.cwd;

      if (requestedCwd === undefined) {
        const fromGlobal = await globalReader.read(name);
        if (fromGlobal) return fromGlobal;
        for (const cwd of projectCwds()) {
          const hit = await projectReader(cwd).read(name);
          if (hit) return { ...hit, cwd };
        }
        return undefined;
      }

      // Caller pinned a specific source. An empty string means "global"
      // explicitly — useful for disambiguating a name shadowed by a
      // project entry.
      if (requestedCwd === "") return globalReader.read(name);

      const hit = await projectReader(requestedCwd).read(name);
      return hit ? { ...hit, cwd: requestedCwd } : undefined;
    },
  };
}

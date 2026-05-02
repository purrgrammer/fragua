// SQL + typed helpers for the `workflows` and `projects` tables —
// catalog metadata refreshed on enqueue, queried by the web UI.

import type { Database } from "bun:sqlite";
import type { Project } from "@swarm/types";

// ─────────────────────────────────────────────────────────────────────
// Workflows
// ─────────────────────────────────────────────────────────────────────

const SELECT_WORKFLOW_SHA_SQL = `SELECT sha FROM workflows WHERE sha = ?`;

/** Cheap existence check used by `enqueueRun` to validate the workflow
 *  pointer before inserting a run row. */
export function workflowExists(db: Database, sha: string): boolean {
  return db.query<{ sha: string }, [string]>(SELECT_WORKFLOW_SHA_SQL).get(sha) != null;
}

interface WorkflowFullRow {
  sha: string;
  name: string;
  dot_source: string;
  created_at: number;
}

const SELECT_WORKFLOW_SQL = `
  SELECT sha, name, dot_source, created_at FROM workflows WHERE sha = ?
`;

export function selectWorkflow(db: Database, sha: string): WorkflowFullRow | null {
  return db.query<WorkflowFullRow, [string]>(SELECT_WORKFLOW_SQL).get(sha) ?? null;
}

const INSERT_WORKFLOW_SQL = `
  INSERT INTO workflows (sha, name, dot_source, created_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(sha) DO NOTHING
`;

export function insertWorkflowIfAbsent(db: Database, sha: string, name: string, dotSource: string, now: number): void {
  db.query(INSERT_WORKFLOW_SQL).run(sha, name, dotSource, now);
}

// ─────────────────────────────────────────────────────────────────────
// Projects (display cache; refreshed on every enqueueRun that carries
// projectName)
// ─────────────────────────────────────────────────────────────────────

const SELECT_PROJECTS_SQL = `
  SELECT id, name, root_path AS rootPath, updated_at AS updatedAt
  FROM projects
  ORDER BY updated_at DESC, id ASC
`;

const SELECT_PROJECT_BY_ID_SQL = `
  SELECT id, name, root_path AS rootPath, updated_at AS updatedAt
  FROM projects
  WHERE id = ?
`;

/**
 * UPSERT pattern: name + root_path are display fields refreshed on every
 * `enqueueRun` so the active clone of a project always wins. Caller
 * provides the timestamp so the store's `now()` injector stays the
 * single source of clock truth.
 */
export const UPSERT_PROJECT_SQL = `
  INSERT INTO projects (id, name, root_path, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    root_path = excluded.root_path,
    updated_at = excluded.updated_at
`;

export function selectProjects(db: Database): Project[] {
  return db.query<Project, []>(SELECT_PROJECTS_SQL).all();
}

export function selectProjectById(db: Database, id: string): Project | null {
  return db.query<Project, [string]>(SELECT_PROJECT_BY_ID_SQL).get(id) ?? null;
}

export function upsertProject(
  db: Database,
  args: { id: string; name: string; rootPath: string | null; now: number },
): void {
  db.query(UPSERT_PROJECT_SQL).run(args.id, args.name, args.rootPath, args.now);
}

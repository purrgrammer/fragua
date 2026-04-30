// Project metadata. Source of truth is each project's
// `<root>/.swarm/config.jsonc` (`id`, `name`); the daemon caches a copy
// in the `projects` table so the UI can label runs without filesystem
// access. `id` is a UUIDv7 minted by `swarm init` and committed to git;
// `rootPath` is local to each clone (the table is last-runner-wins).

export interface Project {
  /** UUIDv7. Same across clones because the source file is committed. */
  id: string;
  /** Human-readable label. Mirror of `config.jsonc.name`, with a
   * `basename(cwd)` fallback when the config doesn't carry one. */
  name: string;
  /** Absolute path to the project root at last-known enqueue time.
   * Nullable for callers that don't have a filesystem (CI, tests). */
  rootPath: string | null;
  /** Wall-clock ms of the last refresh — i.e. the most recent
   * `enqueueRun` that carried this `id`. */
  updatedAt: number;
}

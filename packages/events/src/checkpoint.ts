// Filesystem-backed `CheckpointStore` adapter. Writes
// `<runsDir>/<runId>/checkpoint.json` atomically so a mid-write crash
// leaves either the previous checkpoint or the new one — never a torn
// file. Default runs directory mirrors the JSONL sink's convention.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Checkpoint, CheckpointStore } from "@swarm/core";

export interface JsonlCheckpointStoreOptions {
  /** Absolute root under which each run has its own directory. The
   * store writes `<root>/<runId>/checkpoint.json`. Mirrors the
   * `JsonlSink` + runs-dir convention used by the CLI. */
  runsDir: string;
}

export class JsonlCheckpointStore implements CheckpointStore {
  private readonly runsDir: string;

  constructor(opts: JsonlCheckpointStoreOptions) {
    this.runsDir = opts.runsDir;
  }

  async save(runId: string, checkpoint: Checkpoint): Promise<void> {
    const dir = join(this.runsDir, runId);
    const finalPath = join(dir, "checkpoint.json");
    const tmpPath = `${finalPath}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    // Write to .tmp first then rename — `fs.rename` is atomic on the
    // same filesystem, so a crash mid-write never exposes a partially
    // serialised JSON blob.
    await writeFile(tmpPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    await rename(tmpPath, finalPath);
  }

  async load(runId: string): Promise<Checkpoint | undefined> {
    const path = join(this.runsDir, runId, "checkpoint.json");
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as Checkpoint;
    } catch {
      return undefined;
    }
  }
}

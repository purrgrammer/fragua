// Filesystem-backed `CheckpointStore` adapter. Writes
// `<runsDir>/<runId>/checkpoint.json` atomically so a mid-write crash
// leaves either the previous checkpoint or the new one — never a torn
// file. Default runs directory mirrors the JSONL sink's convention.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
    // Unique tmp suffix so concurrent saves don't race on the same .tmp
    // path. Each writer gets its own file, then `rename` last-write-wins
    // atomically (rename is atomic on POSIX within one filesystem).
    const tmpPath = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort cleanup if the rename failed for any reason.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
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

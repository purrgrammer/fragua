// Content-addressed blob filesystem.
//
// Layout: `<root>/<ab>/<sha256>` where `ab` is the first two hex chars. Two
// levels of sharding keeps any single directory from ballooning past a few
// thousand entries even at ~1M blobs.
//
// Ordering for crash safety:
//
//   put  → write to `<root>/.tmp/<rand>` → fsync → atomic rename → THEN
//          the caller inserts the `blobs` row. A crash between rename and
//          row insert leaves an orphan file (GC will sweep it).
//
//   get  → direct file read. Callers should have confirmed the row exists
//          first so a missing file signals genuine inconsistency.
//
//   del  → the caller DELETEs the row first, then calls `delete` here. A
//          crash between the two leaves an orphan file (GC sweeps).
//
// Why content lives on disk rather than in SQLite: every blob write on
// WAL SQLite frames the full BLOB into the write-ahead log. With live SSE
// readers holding snapshots the WAL can't truncate, a burst of multi-MB
// artifact writes produces disk pressure that starves the daemon's
// coordination ticks. Files on disk are exactly as durable and entirely
// out of the WAL's way.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export class BlobFS {
  private readonly root: string;
  private readonly tmpDir: string;
  private tmpSeq = 0;

  constructor(root: string) {
    this.root = root;
    this.tmpDir = join(root, ".tmp");
    mkdirSync(this.tmpDir, { recursive: true });
  }

  /**
   * Write `content` at the path for `sha`. Idempotent: if the file already
   * exists (same sha ≡ same content by definition), no-op.
   */
  put(sha: string, content: Uint8Array): void {
    const final = this.pathFor(sha);
    if (existsSync(final)) return;
    mkdirSync(shardDir(this.root, sha), { recursive: true });
    const tmp = join(this.tmpDir, `${process.pid}-${Date.now()}-${this.tmpSeq++}`);
    writeFileSync(tmp, content);
    // fsync the file before rename so the bytes reach disk before any
    // database row committed after this function returns points at the path.
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, final);
  }

  get(sha: string): Uint8Array {
    return readFileSync(this.pathFor(sha));
  }

  has(sha: string): boolean {
    return existsSync(this.pathFor(sha));
  }

  delete(sha: string): void {
    const p = this.pathFor(sha);
    if (!existsSync(p)) return;
    try {
      unlinkSync(p);
    } catch {
      // Best-effort: a concurrent GC sweep may have already removed it.
    }
  }

  /** Enumerate every stored sha. Used by GC to find orphan files. */
  listAllShas(): string[] {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    for (const shard of readdirSync(this.root)) {
      if (shard.startsWith(".")) continue;
      if (shard.length !== 2) continue;
      const shardPath = join(this.root, shard);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(shardPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const name of readdirSync(shardPath)) {
        if (name.length === 64) out.push(name);
      }
    }
    return out;
  }

  /** Test / shutdown helper. Removes the whole root. */
  destroy(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  private pathFor(sha: string): string {
    return join(shardDir(this.root, sha), sha);
  }
}

function shardDir(root: string, sha: string): string {
  return join(root, sha.slice(0, 2));
}

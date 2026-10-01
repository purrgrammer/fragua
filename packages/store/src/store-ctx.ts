import type { Database } from "bun:sqlite";
import type { BlobFS } from "./blob-fs.ts";
import type { Metrics } from "./metrics.ts";
import type { IEventStore } from "./types.ts";

/**
 * The private context every store sub-interface module operates against. The
 * `SqliteStore` façade builds one of these in its constructor and threads it
 * to the free functions that hold each interface's method bodies. `writeTxn`
 * and `validatePayload` stay façade-owned (so the I1 transaction lint keeps
 * matching `writeTxn` by name across every module); `store` is the façade
 * itself, used when a method on one sub-interface calls a sibling on another.
 */
export interface StoreCtx {
  readonly db: Database;
  readonly blobs: BlobFS;
  readonly now: () => number;
  readonly metrics: Metrics;
  writeTxn(fn: () => void): void;
  validatePayload(payload: unknown): string;
  readonly store: IEventStore;
}

// Fixture: an engine-style helper that buries a `node:fs` read. Reachable only
// from `leaky-projection.ts`, never from the real `read-plane` entry — it exists
// so the read-plane fs lint can prove it follows value imports out of
// `read-plane/` into `engine/`-shaped helpers.

import { readFileSync } from "node:fs";

export function loadFanoutTable(path: string): string {
  return readFileSync(path, "utf8");
}

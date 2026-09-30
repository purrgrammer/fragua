// Fixture: a projection that value-imports a helper doing `node:fs`, mirroring
// `projections.ts` importing `fanoutBranchClosures` from `engine/`. The lint,
// walking transitively from this entry, must flag the helper's `node:fs` reach.

import { loadFanoutTable } from "./leaky-engine-helper.ts";

export function projectFanout(path: string): string {
  return loadFanoutTable(path);
}

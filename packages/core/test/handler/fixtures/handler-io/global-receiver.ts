// Fixture (R3-M3): a handler that delegates `process.env` and `Bun.*` reaches
// behind a `globalThis.` receiver to a sibling helper. The transitive scan must
// flag both inside `global-helper.ts`.

import { readHomeAndSpawn } from "./global-helper.ts";

export function makeGlobalReceiverHandler(): { kind: string; handler: () => unknown } {
  return { kind: "global-receiver", handler: () => readHomeAndSpawn() };
}

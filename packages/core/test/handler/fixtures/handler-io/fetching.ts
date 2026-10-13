// Fixture: a handler that delegates a raw network call and a `Bun.*` reach to a
// sibling helper. The transitive scan must flag both inside `fetch-helper.ts`.

import { pingAndSpawn } from "./fetch-helper.ts";

export function makeFetchingHandler(): { kind: string; handler: () => Promise<unknown> } {
  return { kind: "fetching", handler: () => pingAndSpawn("https://example.test") };
}

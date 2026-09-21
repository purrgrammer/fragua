// Shared read helpers over pi-ai's bundled (offline) model catalogue.
// Used by the store-free validation suites in `@fragua/agent` and
// `@fragua/cli` so a future `pi-ai/compat` catalog-query rename is a
// single edit here rather than one per test file.

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";

/** Every built-in model across every provider in the bundled registry. */
export function allModels(): Model<Api>[] {
  return getProviders().flatMap((p) => getModels(p) as Model<Api>[]);
}

/** A real (provider, id) pair from the bundled registry. */
export function realPair(): { provider: string; id: string } {
  const m = allModels()[0];
  if (!m) throw new Error("bundled pi-ai registry is empty");
  return { provider: m.provider, id: m.id };
}

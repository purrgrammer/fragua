// Shared fixtures for REST tests.

import { SqliteStore } from "@swarm/store";

export function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:" });
}

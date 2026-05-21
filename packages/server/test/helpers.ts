// Shared fixtures for REST tests.

import { SqliteStore } from "@fragua/store";

export function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:" });
}

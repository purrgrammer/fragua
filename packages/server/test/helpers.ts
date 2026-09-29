// Shared fixtures for REST tests.

import { SqliteStore } from "@fragua/store";
import type { Hono } from "hono";

export function freshStore(): SqliteStore {
  return new SqliteStore({ path: ":memory:" });
}

/** Fire a request through a gated app with a same-origin `Host` header
 * pre-set, so fixtures don't have to hand-set it on every call. Extra
 * headers (Origin, content-type, …) merge over the default Host. */
export async function gatedRequest(
  app: Hono,
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const { host, headers, ...rest } = init;
  const merged = new Headers(headers);
  if (!merged.has("host")) merged.set("host", host ?? "127.0.0.1:6767");
  return app.request(path, { ...rest, headers: merged });
}

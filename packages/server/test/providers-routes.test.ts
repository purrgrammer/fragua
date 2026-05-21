// Routes for `POST /providers/:name/credentials` after the credentials-
// in-the-store proposal landed. The body shape changed from
// `{ kind, value }` to `{ key }` and the localhost-only literal check
// is gone (keys are stored verbatim either way now).
//

import { describe, expect, test } from "bun:test";
import { AuthStorage, ModelRegistry } from "@swarm/agent";
import { SqliteStore } from "@swarm/store";
import { providersRoutes } from "../src/routes/providers.ts";

function mount(): { app: ReturnType<typeof providersRoutes>; store: SqliteStore } {
  const store = new SqliteStore();
  const authStorage = AuthStorage.fromStore(store);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const app = providersRoutes({ authStorage, modelRegistry });
  return { app, store };
}

async function post(app: ReturnType<typeof providersRoutes>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", host: "example.com:1234" },
    body: JSON.stringify(body),
  });
}

describe("POST /providers/:name/credentials", () => {
  test("accepts {key} body and stores verbatim", async () => {
    const { app, store } = mount();
    try {
      const res = await post(app, "/providers/anthropic/credentials", { key: "sk-literal" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean };
      expect(json.ok).toBe(true);

      const row = store.getProviderCredential("anthropic");
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("api_key");
      expect(row!.payload).toEqual({ type: "api_key", key: "sk-literal" });
    } finally {
      store.close();
    }
  });

  test("rejects body missing key field", async () => {
    const { app, store } = mount();
    try {
      const res = await post(app, "/providers/anthropic/credentials", {});
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toBe("bad_request");

      expect(store.getProviderCredential("anthropic")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("no longer accepts {kind,value} shape", async () => {
    const { app, store } = mount();
    try {
      // Legacy body: { kind:"literal", value:"sk-x" }. New validator
      // requires a top-level `key` string; without it, the request
      // rejects 400 rather than silently falling back.
      const res = await post(app, "/providers/anthropic/credentials", {
        kind: "literal",
        value: "sk-legacy",
      });
      expect(res.status).toBe(400);

      expect(store.getProviderCredential("anthropic")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("api_key stored verbatim regardless of !-prefix (no shell-cmd parsing)", async () => {
    const { app, store } = mount();
    try {
      const res = await post(app, "/providers/custom/credentials", {
        key: "!op read 'op://vault/x'",
      });
      expect(res.status).toBe(200);
      const row = store.getProviderCredential("custom");
      // The `!` prefix is part of the stored key; no normalisation.
      expect((row!.payload as { key: string }).key).toBe("!op read 'op://vault/x'");
    } finally {
      store.close();
    }
  });
});

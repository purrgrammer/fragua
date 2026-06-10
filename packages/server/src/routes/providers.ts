// Provider management endpoints.
//
//   GET    /providers                         — list all providers
//   GET    /providers/:name                   — provider detail incl. models
//   POST   /providers/:name/test              — 1-token streamSimple call
//   POST   /providers/:name/credentials       — add/update api_key credentials
//   DELETE /providers/:name/credentials       — remove stored credentials
//
// The web UI uses these to render the Providers page and the per-
// provider credential form. AuthStorage is the source of truth for
// credentials (backed by the global store's `provider_credentials`
// table); ModelRegistry is the source of truth for models.
//
// Security rules:
//   - NEVER return the stored `key` field of an ApiKeyCredential.
//   - `key` is now stored verbatim in the global DB (no !cmd / env-var
//     indirection). Transport-layer protection (TLS / loopback-only
//     bind) is the deployment's responsibility on writes.

import { streamSimple } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry } from "@fragua/agent";
import { defaultModelPerProvider } from "@fragua/agent";
import { Hono } from "hono";

export interface ProvidersRouteOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

interface ProviderSummary {
  name: string;
  model_count: number;
  credentialed: boolean;
  /** Describes *where* the credential came from — matches
   * `AuthStorage.describeAuthSource`. One of `"stored api_key"`,
   * `"stored oauth"`, or `null`. Never includes the key itself. */
  auth_source: string | null;
  /** `api_key` | `oauth` when stored in `provider_credentials`, else
   * `null`. */
  auth_kind: "api_key" | "oauth" | null;
  /** Surface OAuth-login availability so the UI can show a "Sign in"
   * affordance only for providers that actually support it. */
  oauth_available: boolean;
  /** Pre-filled default model id (the same one `fragua daemon start` picks
   * when the user omits `--model`). `null` for custom providers. */
  default_model: string | null;
}

function summarize(name: string, model_count: number, auth: AuthStorage, oauthIds: Set<string>): ProviderSummary {
  const cred = auth.get(name);
  return {
    name,
    model_count,
    credentialed: auth.hasAuth(name),
    auth_source: auth.describeAuthSource(name),
    auth_kind: cred?.type === "api_key" ? "api_key" : cred?.type === "oauth" ? "oauth" : null,
    oauth_available: oauthIds.has(name),
    default_model: (defaultModelPerProvider as Record<string, string>)[name] ?? null,
  };
}

export function providersRoutes(opts: ProvidersRouteOptions): Hono {
  const app = new Hono();
  const { authStorage, modelRegistry } = opts;

  const rebuildOauthIds = () => new Set(authStorage.getOAuthProviders().map((p) => p.id));

  app.get("/providers", (c) => {
    const byProvider = new Map<string, number>();
    for (const m of modelRegistry.getAll()) {
      byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    }
    const oauthIds = rebuildOauthIds();
    const rows: ProviderSummary[] = [...byProvider.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => summarize(name, count, authStorage, oauthIds));
    const loadError = modelRegistry.getError() ?? null;
    return c.json({ providers: rows, provider_config_error: loadError });
  });

  app.get("/providers/:name", (c) => {
    const name = c.req.param("name");
    const models = modelRegistry.getAll().filter((m) => m.provider === name);
    if (models.length === 0) return c.json({ error: "not_found", provider: name }, 404);
    const oauthIds = rebuildOauthIds();
    return c.json({
      ...summarize(name, models.length, authStorage, oauthIds),
      models: models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        baseUrl: m.baseUrl,
      })),
    });
  });

  app.post("/providers/:name/test", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as { model?: string };

    // Resolve model: explicit > provider default > first available.
    const defaultId = (defaultModelPerProvider as Record<string, string>)[name];
    let model = body.model ? modelRegistry.find(name, body.model) : undefined;
    if (!model && !body.model) {
      model = defaultId ? modelRegistry.find(name, defaultId) : undefined;
      if (!model) model = modelRegistry.getAll().find((m) => m.provider === name);
    }
    if (!model) {
      return c.json(
        { ok: false, error: `model "${body.model ?? defaultId ?? "<default>"}" not registered under "${name}"` },
        404,
      );
    }

    if (!authStorage.hasAuth(name)) {
      return c.json({ ok: false, error: `no credentials configured for "${name}"` }, 400);
    }
    const apiKey = await authStorage.getApiKey(name);
    if (!apiKey) {
      return c.json(
        { ok: false, error: `credentials configured but getApiKey returned nothing (shell command may have failed)` },
        500,
      );
    }

    const started = Date.now();
    let firstDeltaMs: number | undefined;
    let outputTokens = 0;
    try {
      const stream = streamSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
        // biome-ignore lint/suspicious/noExplicitAny: pi-ai StreamOptions is an opaque provider-specific bag.
        { maxTokens: 1, apiKey } as any,
      );
      for await (const ev of stream) {
        if (ev.type === "text_delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - started;
        if (ev.type === "done") outputTokens = ev.message.usage?.output ?? 0;
        if (ev.type === "error") {
          return c.json({ ok: false, error: ev.error.errorMessage ?? "unknown provider error" });
        }
      }
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    return c.json({
      ok: true,
      provider: name,
      model: model.id,
      first_delta_ms: firstDeltaMs ?? null,
      total_ms: Date.now() - started,
      output_tokens: outputTokens,
    });
  });

  app.post("/providers/:name/credentials", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    if (!body || typeof body.key !== "string" || body.key.length === 0) {
      return c.json({ error: "bad_request", detail: "body must be { key: string }" }, 400);
    }
    // `key` is stored verbatim. No !cmd / env-var indirection — the
    // credentials-in-the-store proposal cut both from the main path.
    authStorage.set(name, { type: "api_key", key: body.key });
    return c.json({ ok: true });
  });

  app.delete("/providers/:name/credentials", (c) => {
    const name = c.req.param("name");
    if (!authStorage.has(name)) {
      return c.json({ ok: true, removed: false });
    }
    authStorage.remove(name);
    return c.json({ ok: true, removed: true });
  });

  return app;
}

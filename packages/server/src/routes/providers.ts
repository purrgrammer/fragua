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
// credentials; ModelRegistry is the source of truth for models.
//
// Security rules (see SECURITY section below):
//   - NEVER return the `key` field of an ApiKeyCredential.
//   - Writes to `/credentials` with kind="literal" are refused when the
//     Host header isn't localhost — forces remote clients onto env or
//     shell forms, so the key doesn't travel over the wire.

import { streamSimple } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@swarm/agent";
import { defaultModelPerProvider } from "@swarm/agent";
import { Hono } from "hono";

export interface ProvidersRouteOptions {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  /** When false (default: infer from Host header per-request), writes
   * with kind="literal" are refused. Tests pass `true` to skip the
   * check; production wiring just lets the per-request check run. */
  allowLiteralWrites?: boolean;
}

interface ProviderSummary {
  name: string;
  model_count: number;
  credentialed: boolean;
  /** Describes *where* the credential came from — matches
   * `AuthStorage.describeAuthSource`. Never includes the key itself. */
  auth_source: string | null;
  /** `api_key` | `oauth` when stored in auth.json, else `null`. Env-sourced
   * or fallback credentials report `null` here — they're "credentialed"
   * from swarm's perspective but there's no entry to `rm`. */
  auth_kind: "api_key" | "oauth" | null;
  /** Surface OAuth-login availability so the UI can show a "Sign in"
   * affordance only for providers that actually support it. */
  oauth_available: boolean;
  /** Pre-filled default model id (the same one `swarm daemon start` picks
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

function hostIsLocal(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Host header can be "host" or "host:port". Strip the port.
  const host = hostHeader.split(":")[0]?.toLowerCase();
  if (!host) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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
    return c.json({ providers: rows, models_json_error: loadError });
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
    const body = (await c.req.json().catch(() => null)) as { kind: "literal" | "env" | "shell"; value: string } | null;
    if (!body || typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "bad_request", detail: "body must be { kind, value }" }, 400);
    }

    // SECURITY: literal writes must come from localhost unless the
    // caller explicitly opted in (tests). Prevents a shared-host
    // deployment from accepting raw keys over the wire.
    if (body.kind === "literal" && opts.allowLiteralWrites !== true) {
      if (!hostIsLocal(c.req.header("host"))) {
        return c.json(
          {
            error: "literal_over_network",
            detail:
              'kind="literal" stores the key verbatim and is refused over non-localhost connections. Use kind="env" (env var name) or kind="shell" (! command) instead.',
          },
          403,
        );
      }
    }

    // Normalize the stored `key` field so resolve-config-value picks the
    // right strategy at read time:
    //   literal → as-typed
    //   env     → bare variable name (AuthStorage resolves it at read)
    //   shell   → "!cmd" (auto-prefixed)
    let key: string;
    if (body.kind === "literal") {
      key = body.value;
    } else if (body.kind === "env") {
      key = body.value;
    } else if (body.kind === "shell") {
      const trimmed = body.value.trim();
      key = trimmed.startsWith("!") ? trimmed : `!${trimmed}`;
    } else {
      return c.json({ error: "bad_request", detail: `unknown kind: ${(body as { kind?: unknown }).kind}` }, 400);
    }

    authStorage.set(name, { type: "api_key", key });
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

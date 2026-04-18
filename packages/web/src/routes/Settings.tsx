// /settings — read-only diagnostic surface. The route exists so the
// Settings nav entry isn't a dead link; richer config (provider keys,
// run-archive paths) is out of scope for P5.13 and lands in a later
// task.
//
// Three card sections:
//   1. Server URL — the same `/api` base the rest of the client
//      consumes, so what's shown here is what fetches actually use.
//   2. Web bundle version — `import.meta.env.VITE_APP_VERSION` if the
//      build pipeline injects one, "dev" otherwise.
//   3. Observed `SWARM_*` env vars — Vite only exposes variables
//      prefixed with `VITE_`, so we surface anything starting with
//      `VITE_SWARM_`. The prefix detail is documented inline so the
//      next person doesn't wonder why their bare `SWARM_FOO=bar`
//      isn't showing up.

import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.tsx";
import { Separator } from "../components/ui/separator.tsx";
import type { ApiClient } from "../lib/api.ts";

export interface SettingsProps {
  api: ApiClient;
}

export function Settings({ api }: SettingsProps): JSX.Element {
  const version = ((import.meta.env as Record<string, unknown>)["VITE_APP_VERSION"] as string | undefined) ?? "dev";
  // Vite only inlines env vars prefixed with `VITE_` at build time;
  // bare `SWARM_*` values from the operator's shell never reach the
  // browser. We document the convention here so the next person
  // adding a knob knows to use the `VITE_SWARM_` prefix.
  const swarmEnv = collectSwarmEnv(import.meta.env as Record<string, unknown>);

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-4" data-testid="settings-page">
      <h2 className="font-heading text-base font-semibold">Settings</h2>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Server</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Row label="API base URL" value={<code className="font-mono">{api.baseUrl}</code>} />
          <Separator className="my-3" />
          <Row
            label="Health endpoint"
            value={<code className="font-mono text-muted-foreground">{api.baseUrl}/health</code>}
          />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Build</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <Row
            label="Web bundle version"
            value={
              <code className="font-mono" data-testid="settings-version">
                {version}
              </code>
            }
          />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Environment</CardTitle>
        </CardHeader>
        <CardContent className="text-sm" data-testid="settings-env">
          {swarmEnv.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No <code className="font-mono">VITE_SWARM_*</code> variables observed at build time.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {swarmEnv.map(({ key, value }, i) => (
                <li key={key}>
                  {i > 0 && <Separator className="mb-2" />}
                  <Row label={key} value={<code className="font-mono text-muted-foreground">{value}</code>} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <span className="shrink-0 text-muted-foreground text-xs">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

/** Pull every `VITE_SWARM_*` key out of the build-time env, sorted. */
function collectSwarmEnv(env: Record<string, unknown>): Array<{ key: string; value: string }> {
  return Object.keys(env)
    .filter((k) => k.startsWith("VITE_SWARM_"))
    .sort()
    .map((key) => ({ key, value: String(env[key] ?? "") }));
}

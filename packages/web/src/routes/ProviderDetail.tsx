// /providers/:name — per-provider detail with credential form + model
// table. The credential form mirrors the CLI's three modes: literal /
// env-var name / !shell-command. Literal writes fail over the wire
// unless the server is on localhost — the form shows the reason inline
// rather than surprising the user after submit.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import * as api from "../lib/api.ts";
import { queries } from "../lib/queries.ts";

type FormKind = "literal" | "env" | "shell";

export function ProviderDetail(): JSX.Element {
  const { name = "" } = useParams();
  const qc = useQueryClient();
  const { data, isPending, isError, error } = useQuery(queries.providers.detail(name));

  useEffect(() => {
    if (error)
      console.warn(`[ProviderDetail ${name}] load failed —`, error instanceof Error ? error.message : String(error));
  }, [error, name]);

  if (isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (isError || !data)
    return (
      <EmptyState
        title={`Couldn't load provider "${name}"`}
        description={
          <Link to="/providers" className="underline">
            Back to providers
          </Link>
        }
      />
    );

  return (
    <section className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="font-heading text-base font-semibold">{data.name}</h2>
          {data.credentialed ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">
              {data.auth_kind === "oauth" ? "oauth" : "ready"}
            </Badge>
          ) : (
            <Badge variant="secondary">not configured</Badge>
          )}
          {data.default_model && <span className="text-muted-foreground text-xs">default: {data.default_model}</span>}
        </div>
        <Link to="/providers" className="text-muted-foreground text-xs hover:underline">
          ← all providers
        </Link>
      </header>

      <CredentialPanel
        name={data.name}
        source={data.auth_source}
        authKind={data.auth_kind}
        oauthAvailable={data.oauth_available}
        onChange={() => qc.invalidateQueries({ queryKey: queries.providers.all() })}
      />

      <section>
        <h3 className="font-heading text-sm font-semibold">Models ({data.models.length})</h3>
        <div className="mt-2 w-full min-w-0 overflow-x-auto">
          <Table className="table-fixed" data-testid="models-table">
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead className="w-32">API</TableHead>
                <TableHead className="w-28">Context</TableHead>
                <TableHead className="w-28">Max out</TableHead>
                <TableHead className="w-36">Cost (in/out)</TableHead>
                <TableHead className="w-20">Inputs</TableHead>
                <TableHead className="w-20">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((m) => (
                <TableRow key={m.id} data-testid={`model-row-${m.id}`}>
                  <TableCell className="max-w-0 truncate font-mono text-xs" title={m.id}>
                    {m.id}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{m.api}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(m.contextWindow)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatTokens(m.maxTokens)}</TableCell>
                  <TableCell className="text-xs tabular-nums">
                    ${m.cost.input.toFixed(2)} / ${m.cost.output.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-xs">{m.input.join("+")}</TableCell>
                  <TableCell className="text-xs">{m.reasoning ? "yes" : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          Cost is USD per million tokens, from pi-ai's registry. Override stale values via{" "}
          <code className="font-mono">~/.swarm/models.json</code> <code className="font-mono">modelOverrides</code>.
        </p>
      </section>
    </section>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface CredentialPanelProps {
  name: string;
  source: string | null;
  authKind: "api_key" | "oauth" | null;
  oauthAvailable: boolean;
  onChange: () => void;
}

function CredentialPanel({ name, source, authKind, oauthAvailable, onChange }: CredentialPanelProps): JSX.Element {
  const [kind, setKind] = useState<FormKind>("env");
  const [value, setValue] = useState("");
  const [testResult, setTestResult] = useState<api.ProviderTestResult | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => api.setProviderCredentials(name, kind, value),
    onSuccess: () => {
      setValue("");
      setTestResult(null);
      onChange();
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.testProvider(name),
    onSuccess: (result) => setTestResult(result),
    onError: (err) => setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  });

  const rmMutation = useMutation({
    mutationFn: () => api.removeProviderCredentials(name),
    onSuccess: () => {
      setTestResult(null);
      onChange();
    },
  });

  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const literalBlocked = kind === "literal" && !isLocalhost;

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm font-semibold">Credentials</h3>
        {source && <span className="text-muted-foreground text-xs font-mono">current: {source}</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={testMutation.isPending || !source}
          onClick={() => testMutation.mutate()}
          data-testid="credential-test"
        >
          {testMutation.isPending ? "Testing…" : "Test current"}
        </Button>
        {authKind !== null && (
          <Button
            size="sm"
            variant="destructive"
            disabled={rmMutation.isPending}
            onClick={() => {
              if (window.confirm(`Remove stored credentials for "${name}"?`)) rmMutation.mutate();
            }}
            data-testid="credential-rm"
          >
            Remove
          </Button>
        )}
        {oauthAvailable && authKind !== "oauth" && (
          <span className="text-muted-foreground text-xs self-center">
            OAuth login available via <code className="font-mono">swarm providers login {name}</code>
          </span>
        )}
      </div>

      {testResult && (
        <div
          data-testid="credential-test-result"
          className={`mt-3 rounded-md border p-2 text-xs ${
            testResult.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200"
          }`}
        >
          {testResult.ok
            ? `✓ ${testResult.model} responded in ${testResult.total_ms}ms${
                testResult.first_delta_ms != null ? ` (${testResult.first_delta_ms}ms to first token)` : ""
              }`
            : `✗ ${testResult.error}`}
        </div>
      )}

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value || literalBlocked) return;
          saveMutation.mutate();
        }}
      >
        <div>
          <div className="text-xs font-medium">How should swarm read the key at request time?</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {(["literal", "env", "shell"] as FormKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  kind === k ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                }`}
                data-testid={`credential-kind-${k}`}
              >
                {k}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {kind === "literal" && "Stores the key verbatim in auth.json. Refused over non-localhost connections."}
            {kind === "env" && "auth.json stores the env var name; the value is read at each request."}
            {kind === "shell" && "auth.json stores `!cmd`; executed at each request (cached per process)."}
          </p>
        </div>
        <div>
          <Input
            type={kind === "literal" ? "password" : "text"}
            placeholder={
              kind === "literal"
                ? "sk-ant-..."
                : kind === "env"
                  ? "ANTHROPIC_API_KEY"
                  : "op read 'op://vault/item/credential'"
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="credential-input"
            autoComplete="off"
            spellCheck={false}
          />
          {literalBlocked && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              Literal writes are only accepted over localhost. Use <span className="font-mono">env</span> or{" "}
              <span className="font-mono">shell</span> from a remote browser.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!value || literalBlocked || saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save credentials"}
          </Button>
          {saveMutation.isError && (
            <span className="text-xs text-rose-700 dark:text-rose-300">
              {saveMutation.error instanceof Error ? saveMutation.error.message : String(saveMutation.error)}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

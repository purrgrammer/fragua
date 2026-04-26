// /providers — list of LLM providers registered in pi-ai + custom
// entries from ~/.swarm/models.json. Shows credentialed status and
// model count per provider; row click drills into the detail page.
//
// Data comes from `GET /providers` (see @swarm/server's
// routes/providers.ts). The server never exposes the key itself — just
// the human-readable source label ("auth.json api_key (literal)", "env",
// etc.) — so this page is safe to render even if the daemon is serving
// over a non-local socket.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ModelSelectorLogo } from "../components/ai-elements/model-selector";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import * as api from "../lib/api.ts";
import { queries } from "../lib/queries.ts";

export function Providers(): JSX.Element {
  const qc = useQueryClient();
  const { data, isPending, isError, error } = useQuery(queries.providers.list());

  useEffect(() => {
    if (error)
      console.warn("[Providers] failed to load providers —", error instanceof Error ? error.message : String(error));
  }, [error]);

  const [testFeedback, setTestFeedback] = useState<Record<string, api.ProviderTestResult | { pending: true }>>({});

  const testMutation = useMutation({
    mutationFn: ({ name }: { name: string }) => api.testProvider(name),
    onMutate: ({ name }) => {
      setTestFeedback((prev) => ({ ...prev, [name]: { pending: true } }));
    },
    onSuccess: (result, { name }) => {
      setTestFeedback((prev) => ({ ...prev, [name]: result }));
    },
    onError: (err, { name }) => {
      setTestFeedback((prev) => ({
        ...prev,
        [name]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    },
  });

  const rmMutation = useMutation({
    mutationFn: ({ name }: { name: string }) => api.removeProviderCredentials(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queries.providers.all() });
    },
  });

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <header className="flex items-baseline justify-between">
        <h2 className="font-heading text-base font-semibold">Providers</h2>
        <p className="text-muted-foreground text-xs">
          <code className="font-mono">~/.swarm/auth.json</code> + <code className="font-mono">models.json</code>
        </p>
      </header>

      {isPending && (
        <p className="text-muted-foreground text-sm" data-testid="providers-loading">
          Loading…
        </p>
      )}
      {isError && (
        <EmptyState
          data-testid="providers-error"
          title="Couldn't load providers"
          description="The server didn't respond as expected. Check the console for details, or retry shortly."
        />
      )}
      {data?.models_json_error && (
        <div
          data-testid="providers-models-json-error"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
        >
          <div className="font-medium">models.json had errors — built-in providers are still shown.</div>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{data.models_json_error}</pre>
        </div>
      )}
      {data && data.providers.length === 0 && (
        <EmptyState
          data-testid="providers-empty"
          icon={<Cpu className="size-6" />}
          title="No providers registered"
          description="pi-ai should bundle the built-ins; something went wrong during registry load."
        />
      )}
      {data && data.providers.length > 0 && (
        <div className="w-full min-w-0 overflow-x-auto">
          <Table data-testid="providers-table" className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">Name</TableHead>
                <TableHead className="w-24">Models</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-64 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...data.providers]
                .sort((a, b) => {
                  if (a.credentialed !== b.credentialed) return a.credentialed ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map((p) => {
                  const feedback = testFeedback[p.name];
                  return (
                    <TableRow key={p.name} data-testid={`provider-row-${p.name}`}>
                      <TableCell className="max-w-0 truncate font-medium">
                        <Link
                          to={`/providers/${encodeURIComponent(p.name)}`}
                          className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                          data-testid={`provider-link-${p.name}`}
                        >
                          <div className="flex flex-row gap-1 items-center">
                            <ModelSelectorLogo provider={p.name} className="size-4" />
                            {p.name}
                          </div>
                        </Link>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.model_count}</TableCell>
                      <TableCell>
                        {p.credentialed ? (
                          <Badge
                            variant="default"
                            className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
                          >
                            {p.auth_kind === "oauth" ? "oauth" : "ready"}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">not configured</Badge>
                        )}
                      </TableCell>
                      <TableCell className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!p.credentialed || (feedback && "pending" in feedback)}
                          onClick={() => testMutation.mutate({ name: p.name })}
                          data-testid={`provider-test-${p.name}`}
                        >
                          {feedback && "pending" in feedback ? "Testing…" : "Test"}
                        </Button>
                        {p.auth_kind !== null && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              if (window.confirm(`Remove stored credentials for "${p.name}"?`)) {
                                rmMutation.mutate({ name: p.name });
                              }
                            }}
                            data-testid={`provider-rm-${p.name}`}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                        {!p.credentialed && (
                          <Link
                            to={`/providers/${encodeURIComponent(p.name)}`}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
                            data-testid={`provider-configure-${p.name}`}
                          >
                            <KeyRound className="size-3.5" /> Configure
                          </Link>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      )}

      {Object.entries(testFeedback).some(([, v]) => v && !("pending" in v)) && (
        <div className="flex flex-col gap-1" data-testid="test-results">
          {Object.entries(testFeedback).map(([name, result]) => {
            if (!result || "pending" in result) return null;
            const tone = result.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200";
            return (
              <div key={name} data-testid={`test-result-${name}`} className={`rounded-md border p-2 text-xs ${tone}`}>
                <span className="font-medium">{name}</span>
                {result.ok ? (
                  <span>
                    {" "}
                    — {result.model} responded in {result.total_ms}ms
                    {result.first_delta_ms != null ? ` (${result.first_delta_ms}ms to first token)` : ""}
                  </span>
                ) : (
                  <span> — {result.error}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Need the CLI instead? Try <code className="font-mono">swarm providers ls</code>,{" "}
        <code className="font-mono">add</code>, <code className="font-mono">test</code>.
      </p>
    </section>
  );
}

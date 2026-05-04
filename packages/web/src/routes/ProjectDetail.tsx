// /projects/:cwdEnc — runs + workflows filtered to one project root.
//
// `cwdEnc` is the base64url encoding of the absolute path (see
// `lib/projectId.ts`) so paths with `/` survive as a single segment.
// Decoded value is the wire identity sent back to `GET /runs?cwd=`; the
// server does an exact match against `run_state.cwd`. The workflows
// section reuses the global `/workflows` listing and filters
// client-side on `w.cwd === cwd` — the multi-source reader already tags
// each row with its owning project, so no per-project endpoint is
// needed.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import { FileTree } from "../components/ai-elements/file-tree.tsx";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { ApiError } from "../lib/api.ts";
import { buildTree, extToLang, TreeNodeView } from "../lib/file-tree.tsx";
import { formatUsd } from "../lib/format.ts";
import { decodeProjectId } from "../lib/projectId.ts";
import { queries } from "../lib/queries.ts";
import { formatRelative } from "../lib/time.ts";

const CONFIG_PATH = ".swarm/config.jsonc";

type RunStatus = "queued" | "running" | "paused" | "success" | "fail" | "canceled" | "unknown";

export function ProjectDetail(): JSX.Element {
  const { cwdEnc = "" } = useParams();
  const cwd = useMemo(() => decodeProjectId(cwdEnc), [cwdEnc]);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get("path") ?? "";
  const tab: "runs" | "files" = searchParams.get("tab") === "files" ? "files" : "runs";

  const filter = useMemo(() => (cwd ? { cwd } : undefined), [cwd]);
  const { data: rows, isPending, isError, error } = useQuery({ ...queries.runs.list(filter), enabled: cwd !== null });

  const { data: allWorkflows, error: workflowsError } = useQuery({
    ...queries.workflows.list(),
    enabled: cwd !== null,
  });
  const projectWorkflows = useMemo(
    () => (cwd && allWorkflows ? allWorkflows.filter((w) => w.cwd === cwd) : []),
    [cwd, allWorkflows],
  );

  const { data: tree, error: treeError } = useQuery({
    ...queries.projects.tree(cwdEnc),
    enabled: cwd !== null && cwdEnc.length > 0,
  });
  const treeRoot = useMemo(() => buildTree(tree ?? []), [tree]);

  const {
    data: blobText,
    isFetching: blobLoading,
    error: blobError,
  } = useQuery({
    ...queries.projects.blob(cwdEnc, selectedPath),
  });

  const {
    data: configText,
    error: configError,
    isFetching: configLoading,
  } = useQuery({
    ...queries.projects.blob(cwdEnc, CONFIG_PATH),
    enabled: cwd !== null && cwdEnc.length > 0,
    retry: false,
  });

  const stats = useMemo(() => {
    const list = rows ?? [];
    const mix: Record<RunStatus, number> = {
      queued: 0,
      running: 0,
      paused: 0,
      success: 0,
      fail: 0,
      canceled: 0,
      unknown: 0,
    };
    let totalCost = 0;
    let lastActivity: string | undefined;
    for (const r of list) {
      mix[r.status] = (mix[r.status] ?? 0) + 1;
      totalCost += r.costUsd ?? 0;
      if (!lastActivity || r.startedAt > lastActivity) lastActivity = r.startedAt;
    }
    return { total: list.length, mix, totalCost, lastActivity };
  }, [rows]);

  useEffect(() => {
    if (error)
      console.warn("[ProjectDetail] failed to load runs —", error instanceof Error ? error.message : String(error));
    if (workflowsError)
      console.warn(
        "[ProjectDetail] failed to load workflows —",
        workflowsError instanceof Error ? workflowsError.message : String(workflowsError),
      );
    if (treeError)
      console.warn(
        "[ProjectDetail] failed to load file tree —",
        treeError instanceof Error ? treeError.message : String(treeError),
      );
  }, [error, workflowsError, treeError]);

  const handleSelect = (path: string): void => {
    const next = new URLSearchParams(searchParams);
    if (path === selectedPath) {
      next.delete("path");
    } else {
      next.set("path", path);
    }
    setSearchParams(next, { replace: true });
  };

  const handleTabChange = (v: string): void => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", v === "files" ? "files" : "runs");
    setSearchParams(next, { replace: true });
  };

  if (cwd === null) {
    return (
      <EmptyState
        data-testid="project-detail-bad-id"
        title="Invalid project link"
        description={
          <span>
            Couldn't decode that path.{" "}
            <Link to="/projects" className="underline">
              Back to projects
            </Link>
            .
          </span>
        }
      />
    );
  }

  const name = basename(cwd);
  const configMissing = configError instanceof ApiError && configError.status === 404;

  return (
    <section className="flex w-full min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 className="font-heading text-base font-semibold" data-testid="project-detail-name">
          {name}
        </h2>
        <code className="block truncate font-mono text-xs text-sw-muted" title={cwd}>
          {cwd}
        </code>
      </header>

      <section
        data-testid="project-stats-card"
        className="grid grid-cols-2 gap-3 rounded-sw-card border border-sw-border bg-sw-surface p-4 md:grid-cols-4"
      >
        <Stat label="Runs" value={String(stats.total)} testid="project-stats-total" />
        <Stat label="Status mix" value={<StatusMix mix={stats.mix} />} testid="project-stats-mix" />
        <Stat
          label="Total cost"
          value={stats.totalCost > 0 ? formatUsd(stats.totalCost) : "—"}
          testid="project-stats-cost"
        />
        <Stat
          label="Last activity"
          value={stats.lastActivity ? formatRelative(stats.lastActivity) : "—"}
          testid="project-stats-last"
        />
      </section>

      <section className="flex w-full min-w-0 flex-col gap-2" data-testid="project-config-section">
        <h3 className="text-sw-sm font-medium text-sw-muted">Config</h3>
        {configMissing ? (
          <EmptyState
            data-testid="project-config-empty"
            title="No project config"
            description={
              <span>
                Expected at <code className="font-mono">{CONFIG_PATH}</code>.
              </span>
            }
          />
        ) : configError ? (
          <div
            className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted"
            data-testid="project-config-error"
          >
            Couldn't load {CONFIG_PATH}.
          </div>
        ) : configLoading && configText === undefined ? (
          <div className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted">
            Loading…
          </div>
        ) : configText !== undefined ? (
          <div className="overflow-hidden rounded-sw-card border border-sw-border bg-sw-surface">
            <CodeBlock code={configText} language="jsonc" showLineNumbers />
          </div>
        ) : null}
      </section>

      {projectWorkflows.length > 0 && (
        <section className="flex w-full min-w-0 flex-col gap-2" data-testid="project-workflows-section">
          <h3 className="text-sw-sm font-medium text-sw-muted">Workflows</h3>
          <div className="w-full min-w-0 overflow-x-auto">
            <Table data-testid="project-workflows-table" className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">Name</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-24">SHA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projectWorkflows.map((w) => (
                  <TableRow key={w.path} data-testid={`project-workflow-row-${w.name}`}>
                    <TableCell className="max-w-0 truncate font-medium" title={w.label ?? w.name}>
                      <Link
                        to={`/workflows/${encodeURIComponent(w.name)}?cwd=${encodeURIComponent(w.cwd ?? "")}`}
                        className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                        data-testid={`project-workflow-link-${w.name}`}
                      >
                        {w.label ?? w.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-0">
                      <code className="block truncate font-mono text-xs text-sw-muted" title={w.path}>
                        {w.path}
                      </code>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-xs" title={w.sha}>
                        {shortSha(w.sha)}
                      </code>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <Tabs value={tab} onValueChange={handleTabChange} data-testid="project-tabs">
        <TabsList>
          <TabsTrigger value="runs" data-testid="project-tab-runs">
            Runs
          </TabsTrigger>
          <TabsTrigger value="files" data-testid="project-tab-files">
            Files
          </TabsTrigger>
        </TabsList>

        <TabsContent value="runs" className="flex w-full min-w-0 flex-col gap-2">
          {isPending && (
            <p className="text-sw-muted text-sm" data-testid="project-runs-loading">
              Loading…
            </p>
          )}
          {isError && (
            <EmptyState
              data-testid="project-runs-error"
              title="Couldn't load runs"
              description="The server didn't respond as expected. Check the console for details, or retry shortly."
            />
          )}
          {rows && rows.length === 0 && (
            <EmptyState
              data-testid="project-runs-empty"
              title="No runs in this project yet"
              description={
                <span>
                  Runs enqueued from <code className="font-mono">{cwd}</code> show up here.
                </span>
              }
            />
          )}
          {rows && rows.length > 0 && (
            <div className="w-full min-w-0 overflow-x-auto">
              <table className="w-full table-fixed border-collapse" data-testid="project-runs-table">
                <thead>
                  <tr className="border-b">
                    <th className="px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                      Title
                    </th>
                    <th className="w-40 px-2 py-2 text-left align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                      Workflow
                    </th>
                    <th className="w-28 px-2 py-2 text-right align-middle text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <RunRow key={row.runId} row={row} variant="default" />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="flex w-full min-w-0 flex-col gap-2">
          {tree && tree.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[18rem_1fr]" data-testid="project-files-section">
              <div className="max-h-[28rem] overflow-y-auto" data-testid="project-files-tree">
                <FileTree selectedPath={selectedPath} onSelect={handleSelect}>
                  {treeRoot.children.map((child) => (
                    <TreeNodeView key={child.path} node={child} />
                  ))}
                </FileTree>
              </div>
              <div
                className="min-w-0 overflow-hidden rounded-sw-card border border-sw-border bg-sw-surface"
                data-testid="project-files-viewer"
              >
                {selectedPath.length === 0 ? (
                  <div className="p-4 text-sw-sm text-sw-muted">Select a file to preview.</div>
                ) : blobError ? (
                  <BlobError error={blobError} path={selectedPath} />
                ) : blobLoading ? (
                  <div className="p-4 text-sw-sm text-sw-muted">Loading…</div>
                ) : blobText !== undefined ? (
                  <CodeBlock code={blobText} language={extToLang(selectedPath)} showLineNumbers />
                ) : (
                  <div className="p-4 text-sw-sm text-sw-muted">No content.</div>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              data-testid="project-files-empty"
              title="No files indexed for this project"
              description="The project tree is empty or hasn't been scanned yet."
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function Stat({ label, value, testid }: { label: string; value: React.ReactNode; testid: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={testid}>
      <div className="text-xs font-medium uppercase tracking-[0.06em] text-sw-muted">{label}</div>
      <div className="font-mono text-sw-sm text-sw-text">{value}</div>
    </div>
  );
}

function StatusMix({ mix }: { mix: Record<RunStatus, number> }): JSX.Element {
  const order: RunStatus[] = ["running", "queued", "paused", "success", "fail", "canceled", "unknown"];
  const present = order.filter((s) => (mix[s] ?? 0) > 0);
  if (present.length === 0) return <span className="text-sw-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {present.map((s) => (
        <span key={s}>
          <span className="text-sw-muted">{s}</span> {mix[s]}
        </span>
      ))}
    </span>
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function BlobError({ error, path }: { error: unknown; path: string }): JSX.Element {
  const status = error instanceof ApiError ? error.status : 0;
  let msg: string;
  if (status === 413) msg = `File too large to preview (>1 MB).`;
  else if (status === 415) msg = `Binary file — not previewable.`;
  else if (status === 404) msg = `File not found.`;
  else msg = `Couldn't load ${path}.`;
  return <div className="p-4 text-sw-sm text-sw-muted">{msg}</div>;
}

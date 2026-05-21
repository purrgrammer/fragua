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
import { Coins, Database, DollarSign, Play } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import YAML from "yaml";
import { AgentsList } from "../components/agents/agents-list.tsx";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import { FileTree } from "../components/ai-elements/file-tree.tsx";
import { RunComposer } from "../components/RunComposer.tsx";
import { RunRow } from "../components/RunRow.tsx";
import { SkillsList } from "../components/skills/skills-list.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { StatTile } from "../components/ui/stat-tile.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { WorkflowLink } from "../components/WorkflowLink.tsx";
import { ApiError } from "../lib/api.ts";
import { buildTree, extToLang, TreeNodeView } from "../lib/file-tree.tsx";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "../lib/format.ts";
import { decodeProjectId } from "../lib/projectId.ts";
import { queries } from "../lib/queries.ts";
import { computeStats } from "../lib/stats.ts";
import { formatDuration } from "../lib/time.ts";

const CONFIG_PATH_YAML = ".fragua/config.yaml";

export function ProjectDetail(): JSX.Element {
  const { cwdEnc = "" } = useParams();
  const cwd = useMemo(() => decodeProjectId(cwdEnc), [cwdEnc]);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get("path") ?? "";
  const rawTab = searchParams.get("tab");
  const tab: "runs" | "workflows" | "files" | "skills" | "agents" =
    rawTab === "workflows" || rawTab === "files" || rawTab === "skills" || rawTab === "agents" ? rawTab : "runs";

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
    data: configYamlText,
    error: configYamlError,
    isFetching: configYamlLoading,
  } = useQuery({
    ...queries.projects.blob(cwdEnc, CONFIG_PATH_YAML),
    enabled: cwd !== null && cwdEnc.length > 0,
    retry: false,
  });

  const resolvedConfig = useMemo(
    () => pickConfigSource(configYamlText, configYamlError),
    [configYamlText, configYamlError],
  );

  const stats = useMemo(() => computeStats(rows ?? []), [rows]);
  const parsedConfig = useMemo(
    () => (resolvedConfig.text !== undefined ? parseYamlConfig(resolvedConfig.text) : null),
    [resolvedConfig],
  );

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
    const known: Record<string, string> = {
      runs: "runs",
      workflows: "workflows",
      files: "files",
      skills: "skills",
      agents: "agents",
    };
    next.set("tab", known[v] ?? "runs");
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
  const configMissing = resolvedConfig.missing;

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

      <section data-testid="project-stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Runs"
          loading={isPending}
          numericValue={stats.totalRuns}
          format={{ notation: "compact", maximumFractionDigits: 1 }}
          icon={<Play className="size-4" />}
          testId="project-stat-runs"
        />
        <StatTile
          label="Spend"
          loading={isPending}
          numericValue={stats.totalCostUsd}
          format={usdFormatOptions(stats.totalCostUsd)}
          icon={<DollarSign className="size-4" />}
          testId="project-stat-spend"
        />
        <StatTile
          label="Tokens"
          loading={isPending}
          numericValue={stats.billedTokens}
          format={tokensCompactFormatOptions(stats.billedTokens)}
          icon={<Coins className="size-4" />}
          hint={tokensTooltip(stats)}
          testId="project-stat-tokens"
        />
        <StatTile
          label="Cache"
          loading={isPending}
          numericValue={stats.cacheHitRate}
          format={percentFormatOptions()}
          icon={<Database className="size-4" />}
          hint={cacheTooltip(stats)}
          testId="project-stat-cache"
        />
      </section>

      <ConfigSummary
        loading={configYamlLoading && resolvedConfig.text === undefined}
        missing={configMissing}
        errored={!configMissing && resolvedConfig.errored}
        parsed={parsedConfig}
        configPath={resolvedConfig.path}
      />

      <Tabs value={tab} onValueChange={handleTabChange} className="flex flex-col gap-3" data-testid="project-tabs">
        <TabsList variant="line" className="self-start">
          <TabsTrigger value="runs" data-testid="project-tab-runs">
            Runs
          </TabsTrigger>
          <TabsTrigger value="workflows" data-testid="project-tab-workflows">
            Workflows
          </TabsTrigger>
          <TabsTrigger value="files" data-testid="project-tab-files">
            Files
          </TabsTrigger>
          <TabsTrigger value="skills" data-testid="project-tab-skills">
            Skills
          </TabsTrigger>
          <TabsTrigger value="agents" data-testid="project-tab-agents">
            Agents
          </TabsTrigger>
        </TabsList>

        <div className="min-w-0 overflow-auto rounded-md border bg-sw-bg">
          <TabsContent value="runs" className="flex w-full min-w-0 flex-col gap-2 p-3">
            <RunComposer cwd={cwd} workflows={allWorkflows ?? []} />
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

          <TabsContent
            value="workflows"
            className="flex w-full min-w-0 flex-col gap-2 p-3"
            data-testid="project-workflows-section"
          >
            {projectWorkflows.length === 0 ? (
              <EmptyState
                data-testid="project-workflows-empty"
                title="No workflows in this project yet"
                description={
                  <span>
                    Add a <code className="font-mono">.yaml</code> file under{" "}
                    <code className="font-mono">.fragua/workflows/</code> to launch workflows from this project.
                  </span>
                }
              />
            ) : (
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
                          <WorkflowLink
                            name={w.name}
                            cwd={w.cwd ?? ""}
                            variant="plain"
                            className="transition-colors duration-[var(--sw-duration-hover)] hover:underline"
                            data-testid={`project-workflow-link-${w.name}`}
                          >
                            {w.label ?? w.name}
                          </WorkflowLink>
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
            )}
          </TabsContent>

          <TabsContent
            value="skills"
            className="flex w-full min-w-0 flex-col gap-2 p-3"
            data-testid="project-skills-section"
          >
            <SkillsList projectCwd={cwd} projectOnly testIdPrefix="project-skills" />
          </TabsContent>

          <TabsContent
            value="agents"
            className="flex w-full min-w-0 flex-col gap-2 p-3"
            data-testid="project-agents-section"
          >
            <AgentsList projectCwd={cwd} projectOnly testIdPrefix="project-agents" />
          </TabsContent>

          <TabsContent value="files" className="flex w-full min-w-0 flex-col gap-2 p-3">
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
        </div>
      </Tabs>
    </section>
  );
}

function tokensTooltip(stats: ReturnType<typeof computeStats>): string {
  const fmt = new Intl.NumberFormat();
  return [
    `input  ${fmt.format(stats.totalInputTokens)}`,
    `output ${fmt.format(stats.totalOutputTokens)}`,
    `cache read ${fmt.format(stats.totalCacheReadTokens)}`,
    `cache write ${fmt.format(stats.totalCacheWriteTokens)}`,
  ].join(" · ");
}

function cacheTooltip(stats: ReturnType<typeof computeStats>): string {
  const fmt = new Intl.NumberFormat();
  return [
    `cacheRead  ${fmt.format(stats.totalCacheReadTokens)}`,
    `cacheWrite ${fmt.format(stats.totalCacheWriteTokens)}`,
  ].join(" · ");
}

// ─── Config summary ─────────────────────────────────────────────────
//
// Surfaces the keys an operator typically wants to see at a glance —
// bootstrap command, default LLM, concurrency, loop ceilings — instead
// of dumping the raw YAML. The full file is still readable via the
// Files tab, so this view stays purpose-built for "what knobs is this
// project running with?".

interface ConfigSummaryProps {
  loading: boolean;
  missing: boolean;
  errored: boolean;
  parsed: ConfigShape | null;
  configPath: string;
}

function ConfigSummary({ loading, missing, errored, parsed, configPath }: ConfigSummaryProps): JSX.Element {
  const displayPath = configPath || CONFIG_PATH_YAML;
  return (
    <section className="flex w-full min-w-0 flex-col gap-2" data-testid="project-config-section">
      <h3 className="text-sw-sm font-medium text-sw-muted">Config</h3>
      {missing ? (
        <EmptyState
          data-testid="project-config-empty"
          title="No project config"
          description={
            <span>
              Expected at <code className="font-mono">{CONFIG_PATH_YAML}</code>.
            </span>
          }
        />
      ) : errored ? (
        <div
          className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted"
          data-testid="project-config-error"
        >
          Couldn't load {displayPath}.
        </div>
      ) : loading ? (
        <div className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted">
          Loading…
        </div>
      ) : parsed === null ? (
        <div
          className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted"
          data-testid="project-config-unparsable"
        >
          Couldn't parse {displayPath}.
        </div>
      ) : (
        <ConfigValues parsed={parsed} />
      )}
    </section>
  );
}

interface ConfigShape {
  name?: string;
  bootstrap?: string;
  "bootstrap-timeout-ms"?: number;
  "auto-title"?: boolean;
  concurrency?: number;
  "max-loops"?: number;
  defaults?: {
    provider?: string;
    model?: string;
    permissions?: string;
  };
}

function ConfigValues({ parsed }: { parsed: ConfigShape }): JSX.Element {
  const rows: { label: string; value: React.ReactNode; testid: string }[] = [];
  if (parsed.name)
    rows.push({
      label: "Name",
      value: <span className="text-sw-text">{parsed.name}</span>,
      testid: "project-config-name",
    });
  if (parsed.defaults?.provider || parsed.defaults?.model) {
    rows.push({
      label: "Default LLM",
      value: (
        <code className="font-mono text-sw-text">
          {[parsed.defaults?.provider, parsed.defaults?.model].filter(Boolean).join(" · ")}
        </code>
      ),
      testid: "project-config-llm",
    });
  }
  if (parsed.defaults?.permissions) {
    rows.push({
      label: "Permissions",
      value: <code className="font-mono text-sw-text">{parsed.defaults.permissions}</code>,
      testid: "project-config-permissions",
    });
  }
  if (parsed.bootstrap) {
    rows.push({
      label: "Bootstrap",
      value: (
        <code className="block truncate font-mono text-sw-text" title={parsed.bootstrap}>
          {parsed.bootstrap}
        </code>
      ),
      testid: "project-config-bootstrap",
    });
  }
  const bootstrapTimeoutMs = parsed["bootstrap-timeout-ms"];
  if (bootstrapTimeoutMs !== undefined) {
    rows.push({
      label: "Bootstrap timeout",
      value: <span className="text-sw-text">{formatDuration(bootstrapTimeoutMs)}</span>,
      testid: "project-config-bootstrap-timeout",
    });
  }
  if (parsed.concurrency !== undefined) {
    rows.push({
      label: "Concurrency",
      value: <span className="text-sw-text">{parsed.concurrency}</span>,
      testid: "project-config-concurrency",
    });
  }
  const maxLoops = parsed["max-loops"];
  if (maxLoops !== undefined) {
    rows.push({
      label: "Max loops",
      value: <span className="text-sw-text">{maxLoops}</span>,
      testid: "project-config-max-loops",
    });
  }
  const autoTitle = parsed["auto-title"];
  if (autoTitle !== undefined) {
    rows.push({
      label: "Auto-title",
      value: <span className="text-sw-text">{autoTitle ? "On" : "Off"}</span>,
      testid: "project-config-auto-title",
    });
  }

  if (rows.length === 0) {
    return (
      <div
        className="rounded-sw-card border border-sw-border bg-sw-surface p-4 text-sw-sm text-sw-muted"
        data-testid="project-config-defaults"
      >
        Project uses defaults — no overrides set in <code className="font-mono">{CONFIG_PATH_YAML}</code>.
      </div>
    );
  }

  return (
    <dl
      className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-sw-card border border-sw-border bg-sw-surface p-4 sm:grid-cols-[10rem_1fr]"
      data-testid="project-config-values"
    >
      {rows.map((r) => (
        <div key={r.testid} className="contents" data-testid={r.testid}>
          <dt className="truncate text-sw-xs font-medium uppercase tracking-[0.06em] text-sw-muted">{r.label}</dt>
          <dd className="min-w-0 text-sw-sm">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Config source resolution ──────────────────────────────────────

interface ResolvedConfigSource {
  path: string;
  text: string | undefined;
  missing: boolean;
  errored: boolean;
}

function pickConfigSource(yamlText: string | undefined, yamlError: unknown): ResolvedConfigSource {
  const yamlMissing = yamlError instanceof ApiError && yamlError.status === 404;

  if (yamlText !== undefined) {
    return { path: CONFIG_PATH_YAML, text: yamlText, missing: false, errored: false };
  }
  if (!yamlMissing && yamlError != null) {
    return { path: CONFIG_PATH_YAML, text: undefined, missing: false, errored: true };
  }
  return { path: CONFIG_PATH_YAML, text: undefined, missing: yamlMissing, errored: false };
}

// ─── Config parser ──────────────────────────────────────────────────

function parseYamlConfig(src: string): ConfigShape | null {
  try {
    const value = YAML.parse(src);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as ConfigShape;
    }
    return null;
  } catch {
    return null;
  }
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

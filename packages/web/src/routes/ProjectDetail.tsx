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
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "../components/ai-elements/code-block.tsx";
import { FileTree, FileTreeFile, FileTreeFolder } from "../components/ai-elements/file-tree.tsx";
import { RunRow } from "../components/RunRow.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import type { ProjectTreeEntry } from "../lib/api.ts";
import { ApiError } from "../lib/api.ts";
import { decodeProjectId } from "../lib/projectId.ts";
import { queries } from "../lib/queries.ts";

export function ProjectDetail(): JSX.Element {
  const { cwdEnc = "" } = useParams();
  const cwd = useMemo(() => decodeProjectId(cwdEnc), [cwdEnc]);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPath = searchParams.get("path") ?? "";

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

      {tree && tree.length > 0 && (
        <section className="flex w-full min-w-0 flex-col gap-2" data-testid="project-files-section">
          <h3 className="text-sw-sm font-medium text-sw-muted">Files</h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[18rem_1fr]">
            <div className="max-h-[28rem] overflow-y-auto" data-testid="project-files-tree">
              <FileTree selectedPath={selectedPath} onSelect={handleSelect}>
                {treeRoot.children.map((child) => (
                  <TreeNodeView key={child.path} node={child} />
                ))}
              </FileTree>
            </div>
            <div className="min-w-0 overflow-hidden rounded-lg border bg-sw-surface" data-testid="project-files-viewer">
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
        </section>
      )}

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
    </section>
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

// ── File-tree helpers ─────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

/** Fold the flat `{path,type}[]` the server returns into the nested
 *  shape `<FileTree>` consumes. Folders appear in the input only when
 *  they contain at least one file (the server includes every ancestor),
 *  so we don't need to invent empty directories here. */
function buildTree(entries: ProjectTreeEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirByPath = new Map<string, TreeNode>();
  dirByPath.set("", root);

  const ensureDir = (path: string): TreeNode => {
    const cached = dirByPath.get(path);
    if (cached) return cached;
    const segs = path.split("/");
    const name = segs[segs.length - 1] ?? path;
    const parentPath = segs.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name, path, type: "dir", children: [] };
    parent.children.push(node);
    dirByPath.set(path, node);
    return node;
  };

  for (const e of entries) {
    if (e.type === "dir") ensureDir(e.path);
  }
  for (const e of entries) {
    if (e.type !== "file") continue;
    const segs = e.path.split("/");
    const name = segs[segs.length - 1] ?? e.path;
    const parentPath = segs.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    parent.children.push({ name, path: e.path, type: "file", children: [] });
  }

  // Folders before files, then alphabetical within each group.
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (const c of n.children) if (c.type === "dir") sortRec(c);
  };
  sortRec(root);
  return root;
}

function TreeNodeView({ node }: { node: TreeNode }): JSX.Element {
  if (node.type === "file") {
    return <FileTreeFile path={node.path} name={node.name} />;
  }
  return (
    <FileTreeFolder path={node.path} name={node.name}>
      {node.children.map((child) => (
        <TreeNodeView key={child.path} node={child} />
      ))}
    </FileTreeFolder>
  );
}

/** Best-effort extension → shiki BundledLanguage. Anything unknown
 *  falls back to plain text so the viewer renders without trying to
 *  load a non-existent grammar. */
function extToLang(path: string): BundledLanguage {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "shell";
  const ext = path.slice(dot + 1).toLowerCase();
  const map: Partial<Record<string, BundledLanguage>> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    mdx: "mdx",
    html: "html",
    css: "css",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    sql: "sql",
    toml: "toml",
  };
  return map[ext] ?? "bash";
}

function BlobError({ error, path }: { error: unknown; path: string }): JSX.Element {
  const status = error instanceof ApiError ? error.status : 0;
  let msg: string;
  if (status === 413) msg = `File too large to preview (>1 MB).`;
  else if (status === 415) msg = `Binary file — not previewable.`;
  else if (status === 404) msg = `File not found.`;
  else msg = `Couldn't load ${path}.`;
  return <div className="p-4 text-sw-sm text-sw-muted">{msg}</div>;
}

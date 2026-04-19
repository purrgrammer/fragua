// /workflows/:name — static workflow detail page.
//
// Two-pane bento: the parsed graph on the left (via `GraphView mode="graph"`)
// and a `NodeInspector` on the right for whichever node the user clicks.
// No live run is involved — this is the "what does this workflow do?"
// answer before you press launch. Topology is parsed client-side via
// `@swarm/core`'s `parseDotSource`; on parse failure the server's raw
// DOT is still rendered so operators can debug the source.
//
// Route params / data:
//   - `:name` → `queries.workflows.detail(name)` → `{ name, label, path,
//     sha, source }`.
//   - Parsed `Graph` is memoised off `detail.source` so clicks don't
//     reparse.
//   - `selectedNodeId` is local state; the graph shows it as a neutral
//     ring, and the inspector reads the matching `Graph.nodes[id]`.

import { parseDotSource } from "@swarm/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GraphView } from "../components/GraphView.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { ApiError } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";

export function WorkflowDetail(): JSX.Element {
  const { name = "" } = useParams();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const { data: detail, isPending, error } = useQuery({ ...queries.workflows.detail(name), enabled: !!name });

  const graph = useMemo(() => {
    if (!detail?.source) return null;
    try {
      return parseDotSource(detail.source);
    } catch {
      return null;
    }
  }, [detail?.source]);

  if (!name) {
    return (
      <EmptyState
        data-testid="workflow-detail-missing-name"
        title="Missing workflow name"
        description="The URL didn't include a workflow name."
        action={
          <Link to="/workflows" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all workflows
          </Link>
        }
      />
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        data-testid="workflow-detail-not-found"
        title="Workflow not found"
        description={
          <span>
            No workflow named <code className="font-mono">{name}</code>. It may have been renamed or removed.
          </span>
        }
        action={
          <Link to="/workflows" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all workflows
          </Link>
        }
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        data-testid="workflow-detail-error"
        title="Couldn't load workflow"
        description="The server didn't return this workflow. Check the console for details."
        action={
          <Link to="/workflows" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            ← all workflows
          </Link>
        }
      />
    );
  }

  if (isPending || !detail) {
    return (
      <section className="flex w-full min-w-0 flex-col gap-3">
        <p data-testid="workflow-detail-loading" className="text-sw-sm text-sw-muted">
          Loading…
        </p>
      </section>
    );
  }

  const selected = selectedNodeId && graph ? (graph.nodes[selectedNodeId] ?? null) : null;

  return (
    <section data-testid="workflow-detail" className="flex h-full w-full min-w-0 flex-col gap-4">
      <header className="min-w-0">
        <Link to="/workflows" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
          ← all workflows
        </Link>
        <h2
          data-testid="workflow-detail-title"
          className="mt-1 truncate text-sw-lg font-semibold text-sw-text"
          title={detail.label ?? detail.name}
        >
          {detail.label ?? detail.name}
        </h2>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sw-xs text-sw-muted">
          <span>
            name: <code className="text-sw-text">{detail.name}</code>
          </span>
          <span>·</span>
          <span title={detail.path}>
            path: <code className="text-sw-text">{detail.path}</code>
          </span>
          <span>·</span>
          <span title={detail.sha}>
            sha:{" "}
            <code data-testid="workflow-detail-sha" className="text-sw-text">
              {shortSha(detail.sha)}
            </code>
          </span>
        </p>
      </header>

      {graph ? (
        <div className="grid min-h-[480px] flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-h-[480px] min-w-0">
            <GraphView graph={graph} orientation="TB" selectedNodeId={selectedNodeId} onNodeClick={setSelectedNodeId} />
          </div>
          <NodeInspector node={selected} />
        </div>
      ) : (
        <EmptyState
          data-testid="workflow-detail-parse-error"
          title="Couldn't parse workflow"
          description="The server returned the DOT source but it didn't parse. The raw source is below so you can inspect it."
        />
      )}

      {!graph && (
        <pre
          data-testid="workflow-detail-source"
          className="max-h-[60vh] overflow-auto rounded-sw-card border border-sw-border bg-sw-surface p-3 text-sw-xs text-sw-text"
        >
          {detail.source}
        </pre>
      )}
    </section>
  );
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

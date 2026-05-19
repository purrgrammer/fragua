// /workflows/:name — static workflow detail page.
//
// The parsed graph spans the full width; clicking a node opens a
// right-side `Sheet` drawer with `NodeInspector` so the topology stays
// uncropped while the operator inspects details.
// No live run is involved — this is the "what does this workflow do?"
// answer before you press launch. Topology is parsed client-side via
// `@swarm/core`'s `parseWorkflow`; on parse failure the server's raw
// YAML source is still rendered so operators can debug it.
//
// Route params / data:
//   - `:name` → `queries.workflows.detail(name)` → `{ name, label, path,
//     sha, source }`.
//   - Parsed `Graph` is memoised off `detail.source` so clicks don't
//     reparse.
//   - `selectedNodeId` is local state; the graph shows it as a neutral
//     ring, and the drawer reads the matching `Graph.nodes[id]`.

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { GraphView } from "../components/GraphView.tsx";
import { NodeInspector } from "../components/NodeInspector.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { ApiError } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { parseWorkflow } from "@swarm/core";
import { queries } from "../lib/queries.ts";

// Side drawer crossing ~28rem reads as rushed at the system's default
// 200ms (tuned for popovers); slow entrance to 280ms ease-out, exit to
// 220ms, and collapse to ~0ms under prefers-reduced-motion. Mirrors the
// override used by `DrillDownDrawer` so all right-side drawers share a
// cadence without globally retuning the token.
const DRAWER_MOTION = cn(
  "data-open:[animation-duration:280ms] data-open:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "data-closed:[animation-duration:220ms] data-closed:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "motion-reduce:data-open:[animation-duration:1ms] motion-reduce:data-closed:[animation-duration:1ms]",
);

export function WorkflowDetail(): JSX.Element {
  const { name = "" } = useParams();
  const [searchParams] = useSearchParams();
  // `?cwd=` pins lookup to a specific source. Empty string is meaningful
  // (explicit global pin); `null` (param absent) lets the server use the
  // default precedence (global → projects in recency order).
  const cwdParam = searchParams.get("cwd");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const {
    data: detail,
    isPending,
    error,
  } = useQuery({
    ...queries.workflows.detail(name, cwdParam ?? undefined),
    enabled: !!name,
  });

  const graph = useMemo(() => {
    if (!detail?.source) return null;
    try {
      return parseWorkflow(detail.source);
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
          <Link to="/workflows" className="text-sw-xs text-sw-muted hover:text-sw-text hover:underline">
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
          <Link to="/workflows" className="text-sw-xs text-sw-muted hover:text-sw-text hover:underline">
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
          <Link to="/workflows" className="text-sw-xs text-sw-muted hover:text-sw-text hover:underline">
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
  const goal = graph?.attrs.goal;

  return (
    <section data-testid="workflow-detail" className="flex h-full w-full min-w-0 flex-col gap-4">
      <header className="min-w-0">
        <Link to="/workflows" className="text-sw-xs text-sw-muted hover:text-sw-text hover:underline">
          ← all workflows
        </Link>
        <h2
          data-testid="workflow-detail-title"
          className="mt-1 truncate text-sw-lg font-semibold text-sw-text"
          title={detail.label ?? detail.name}
        >
          {detail.label ?? detail.name}
        </h2>
        {goal && (
          <p data-testid="workflow-detail-goal" className="mt-2 text-sw-sm text-sw-text">
            {goal}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sw-xs text-sw-muted">
          <span>
            name: <code className="text-sw-text">{detail.name}</code>
          </span>
          <span>·</span>
          <span title={detail.cwd ?? "~/.swarm/workflows"}>
            source: <code className="text-sw-text">{detail.cwd ? basename(detail.cwd) : "global"}</code>
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
        <>
          <div className="min-h-[480px] min-w-0 flex-1">
            <GraphView graph={graph} orientation="TB" selectedNodeId={selectedNodeId} onNodeClick={setSelectedNodeId} />
          </div>
          <Sheet
            open={selected !== null}
            onOpenChange={(open) => {
              if (!open) setSelectedNodeId(null);
            }}
          >
            <SheetContent side="right" className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-md", DRAWER_MOTION)}>
              {selected ? (
                <>
                  <SheetHeader className="border-b border-sw-border px-4 py-3">
                    <SheetTitle className="truncate text-sw-md font-medium text-sw-text">
                      {selected.attrs.label ?? selected.id}
                    </SheetTitle>
                    <SheetDescription className="text-sw-xs text-sw-muted">Node configuration</SheetDescription>
                  </SheetHeader>
                  <NodeInspector node={selected} className="min-h-0 flex-1 rounded-none border-0 bg-transparent" />
                </>
              ) : null}
            </SheetContent>
          </Sheet>
        </>
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

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

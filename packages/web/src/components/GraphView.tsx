// GraphView — renders a server-rendered SVG for a pipeline run and wires
// up click delegation on any element carrying `data-node-id`.
//
// Why injection via `dangerouslySetInnerHTML`:
//   The server ships a complete `<svg>…</svg>` document produced by
//   Graphviz. Re-parsing it client-side (e.g. with DOMParser, then
//   cloneNode into a React tree) would cost time + bytes for no win. We
//   trust the server output — it comes from our own `@swarm/server`
//   graphRoutes and never echoes user-controlled HTML.
//
// Click delegation:
//   We attach a single `onClick` to the wrapper and use `.closest()` to
//   find the nearest `[data-node-id]`. This keeps us out of the business
//   of re-binding listeners whenever the SVG re-renders (which happens on
//   every SSE `node.*` event).
//
// Error handling:
//   A 404 from the graph endpoint is a normal outcome — runs created
//   before the graph route existed, or runs that crashed before
//   `pipeline.started` fired, legitimately have no SVG. We render an
//   `EmptyState` instead of surfacing the raw fetch error. The underlying
//   error still goes to `console.warn` for dev diagnostics.

import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import styles from "./GraphView.module.css";
import { EmptyState } from "./ui/empty-state.tsx";

export interface GraphViewProps {
  /** Directly supply the SVG string. Overrides `runId`/`api` when present. */
  svg?: string;
  /** When provided, we fetch `/pipelines/:runId/graph.svg` on mount. */
  runId?: string;
  /** API client used to fetch the graph when `runId` is set. */
  api?: ApiClient;
  /**
   * When a node is clicked, fire with the `data-node-id`. Return values
   * ignored — callers typically navigate or toggle a drilldown panel.
   */
  onNodeClick?: (nodeId: string) => void;
  /** Highlight this node id with the `data-active="true"` style. */
  activeNodeId?: string | null;
  /**
   * When this value changes, we re-fetch the SVG (if `runId` is set).
   * Consumers pass e.g. `events.length` from `useSSE` so the graph stays
   * in sync with live updates.
   */
  refetchKey?: number | string;
}

type FetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; svg: string }
  // We collapse error + legitimate-absence into one bucket: the UX is the
  // same either way (a graceful empty state). We keep the raw message for
  // the console.warn, but never render it.
  | { kind: "empty"; reason: string };

export function GraphView(props: GraphViewProps): JSX.Element {
  const { svg, runId, api, onNodeClick, activeNodeId, refetchKey } = props;
  const [fetchState, setFetchState] = useState<FetchState>(() =>
    svg !== undefined ? { kind: "ready", svg } : runId && api ? { kind: "loading" } : { kind: "idle" },
  );

  // External `svg` prop wins — sync into state so re-renders track it.
  useEffect(() => {
    if (svg !== undefined) setFetchState({ kind: "ready", svg });
  }, [svg]);

  // `refetchKey` is a deliberate trigger — bumping it re-runs the effect
  // even though the value itself is unused inside the body. The directive
  // below MUST remain a single line for Biome to attach it to the hook.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchKey is an intentional re-run trigger; its value is not read in the body.
  useEffect(() => {
    if (svg !== undefined || !runId || !api) return;
    let cancelled = false;
    setFetchState({ kind: "loading" });
    api
      .getPipelineGraph(runId)
      .then((text) => {
        if (cancelled) return;
        if (!isLikelySvg(text)) {
          console.warn("[GraphView] server returned a non-SVG payload for", runId);
          setFetchState({ kind: "empty", reason: "non-svg payload" });
          return;
        }
        setFetchState({ kind: "ready", svg: text });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // Devs still get the full error; users get the empty state.
        console.warn("[GraphView] failed to load graph for", runId, "—", message);
        setFetchState({ kind: "empty", reason: message });
      });
    return () => {
      cancelled = true;
    };
  }, [svg, runId, api, refetchKey]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!onNodeClick) return;
    const target = e.target as Element | null;
    if (!target) return;
    const host = target.closest?.("[data-node-id]") as HTMLElement | SVGElement | null;
    if (!host) return;
    const id = host.getAttribute("data-node-id");
    if (id) onNodeClick(id);
  };

  if (fetchState.kind === "loading") {
    return (
      <div className={styles["container"]} data-testid="graph-view">
        <div className={styles["fallback"]}>Loading graph…</div>
      </div>
    );
  }

  if (fetchState.kind === "empty" || fetchState.kind === "idle") {
    // Both "explicit fetch failed" and "nothing to fetch yet" render the
    // same calm empty state. Runs legitimately have no graph in some
    // cases (pre-feature runs, pre-`pipeline.started` crashes).
    return (
      <div className={styles["container"]} data-testid="graph-view">
        <EmptyState
          data-testid="graph-empty"
          title="No graph available for this run"
          description={runId ? <span className="font-mono">{shortRunId(runId)}</span> : undefined}
        />
      </div>
    );
  }

  // `fetchState.kind === "ready"`. Defensive check in case the SVG was set
  // directly via the `svg` prop and is malformed.
  if (!isLikelySvg(fetchState.svg)) {
    return (
      <div className={styles["container"]} data-testid="graph-view">
        <EmptyState
          data-testid="graph-empty"
          title="No graph available for this run"
          description={runId ? <span className="font-mono">{shortRunId(runId)}</span> : undefined}
        />
      </div>
    );
  }

  const html = activeNodeId
    ? // Post-process the SVG to set `data-active="true"` on the matching
      // node. A targeted string replace is O(n) and handles typical
      // Graphviz output (one `data-node-id="X"` attribute per node group).
      applyActiveMarker(fetchState.svg, activeNodeId)
    : fetchState.svg;

  return (
    <div className={styles["container"]} data-testid="graph-view">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click delegation wrapper for an injected SVG. */}
      <div
        role="presentation"
        className={styles["inner"]}
        onClick={handleClick}
        onKeyDown={(e) => {
          // Keyboard parity: Enter/Space on a focused node triggers click.
          if (e.key !== "Enter" && e.key !== " ") return;
          const host = (e.target as Element | null)?.closest?.("[data-node-id]") as HTMLElement | null;
          if (host && onNodeClick) {
            const id = host.getAttribute("data-node-id");
            if (id) onNodeClick(id);
          }
        }}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server output
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function isLikelySvg(text: string): boolean {
  return typeof text === "string" && text.includes("<svg");
}

function applyActiveMarker(svg: string, nodeId: string): string {
  const needle = `data-node-id="${nodeId}"`;
  const idx = svg.indexOf(needle);
  if (idx < 0) return svg;
  return `${svg.slice(0, idx + needle.length)} data-active="true"${svg.slice(idx + needle.length)}`;
}

/** Truncate to the first 8 chars — matches the PipelinesList shortener. */
function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

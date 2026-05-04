// Side drawer that lists the runs composing a chart slice. Opens from
// the right; reuses RunRow `variant="compact"` so each row matches the
// rest of the app and links straight to the run detail page.
//
// Pagination: cursor-based via `/analytics/runs`. The "load more"
// affordance manually advances the cursor (useState); each page is its
// own TanStack Query keyed on the cursor + filters.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { RunSummary } from "@/lib/api";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { DrillSlice } from "@/types/analytics";
import { RunRow } from "../RunRow.tsx";
import { Button } from "../ui/button.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

export interface DrillDownDrawerProps {
  slice: DrillSlice | null;
  onOpenChange: (open: boolean) => void;
}

// A side drawer crossing ~28rem of travel reads as rushed at the design
// system's default `--sw-duration-enter` (200ms), which is tuned for
// popovers/tooltips. Override scoped to this consumer so other Sheet usages
// keep the system cadence; entrance uses an Apple-style ease-out for a
// confident-but-soft settle, exit is ~20% faster, and prefers-reduced-motion
// collapses both to ~0ms (instant state swap without keyframe motion).
const DRAWER_MOTION = cn(
  "data-open:[animation-duration:280ms] data-open:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "data-closed:[animation-duration:220ms] data-closed:[animation-timing-function:cubic-bezier(0.32,0.72,0,1)]",
  "motion-reduce:data-open:[animation-duration:1ms] motion-reduce:data-closed:[animation-duration:1ms]",
);

export function DrillDownDrawer({ slice, onOpenChange }: DrillDownDrawerProps): JSX.Element {
  return (
    <Sheet open={slice !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn("flex w-full flex-col gap-0 sm:max-w-md", DRAWER_MOTION)}>
        {slice ? <Body slice={slice} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function Body({ slice }: { slice: DrillSlice }): JSX.Element {
  // Accumulate pages on the client. Each new cursor triggers a separate
  // query; we concat results in render. Reset on slice change is
  // implicit because the parent unmounts the drawer body when `slice`
  // identity changes (different filters open a fresh drawer).
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  return (
    <>
      <SheetHeader className="border-b border-sw-border px-4 py-3">
        <SheetTitle className="text-sw-md font-medium text-sw-text">{slice.title}</SheetTitle>
        <SheetDescription className="text-sw-xs text-sw-muted">
          Runs in this slice — click any to view details.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-2">
          {cursors.map((cursor, i) => (
            <DrillPage
              key={cursor ?? "first"}
              slice={slice}
              cursor={cursor}
              onAdvance={(next) => {
                if (next == null) return;
                setCursors((prev) =>
                  // Only append if this is the last loaded page (avoid
                  // double-appending when stale "Load more" buttons fire).
                  i === prev.length - 1 ? [...prev, next] : prev,
                );
              }}
              isLastPage={i === cursors.length - 1}
            />
          ))}
        </div>
      </div>
    </>
  );
}

interface DrillPageProps {
  slice: DrillSlice;
  cursor: string | null;
  onAdvance: (next: string | null) => void;
  isLastPage: boolean;
}

function DrillPage({ slice, cursor, onAdvance, isLastPage }: DrillPageProps): JSX.Element {
  const requestArgs: Parameters<typeof queries.analytics.drilldown>[0] = {
    fromMs: slice.fromMs,
    toMs: slice.toMs,
  };
  if (slice.workflowSha) requestArgs.workflowSha = slice.workflowSha;
  if (slice.workflowScope && slice.workflowName) {
    requestArgs.workflowScope = slice.workflowScope;
    requestArgs.workflowName = slice.workflowName;
  }
  if (slice.haltCategory) requestArgs.haltCategory = slice.haltCategory;
  if (slice.model) requestArgs.model = slice.model;
  if (slice.cwd) requestArgs.cwd = slice.cwd;
  if (cursor) requestArgs.cursor = cursor;
  const { data, isPending, isError } = useQuery(queries.analytics.drilldown(requestArgs));

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return <EmptyState density="compact" title="Failed to load runs." />;
  }
  if (data.runs.length === 0 && cursor == null) {
    return <EmptyState density="compact" title="No runs in this slice." />;
  }

  return (
    <>
      {data.runs.map((row: RunSummary) => (
        <RunRow key={row.runId} row={row} variant="compact" />
      ))}
      {isLastPage && data.nextCursor ? (
        <div className="pt-1">
          <Button variant="ghost" size="sm" className="w-full" onClick={() => onAdvance(data.nextCursor)}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

// Inline HITL panels on a parent for any sub-run that's paused on a
// wait.human gate. The operator never has to navigate to the child run
// page — pause-class state on a branch is the parent's surface.
//
// Renders one HitlChoice card per paused_hitl child. Each fetches the
// child's RunDetail to read `hitlLabel` / `hitlOptions`; the cache is
// shared with any other place that uses queries.runs.detail.

import { useQueries } from "@tanstack/react-query";
import * as api from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { HitlChoice } from "./HitlChoice.tsx";

export interface ChildHitlChoicesProps {
  /** Parent's sub-run list. Only `paused_hitl` rows produce a panel. */
  children: readonly api.RunSummary[] | undefined;
}

export function ChildHitlChoices({ children }: ChildHitlChoicesProps): JSX.Element | null {
  const pausedHitlChildren = (children ?? []).filter((c) => c.runStatus === "paused_hitl");
  const detailQueries = useQueries({
    queries: pausedHitlChildren.map((c) => queries.runs.detail(c.runId)),
  });
  if (pausedHitlChildren.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="child-hitl-choices">
      {pausedHitlChildren.map((c, idx) => {
        const detail = detailQueries[idx]?.data as api.RunDetail | undefined;
        const options = detail?.hitlOptions ?? [];
        if (options.length === 0) return null;
        const label =
          detail?.hitlLabel ?? `${c.branchNodeId ?? c.parentNodeId ?? "branch"} — awaiting input`;
        return <HitlChoice key={c.runId} runId={c.runId} label={label} options={options} />;
      })}
    </div>
  );
}

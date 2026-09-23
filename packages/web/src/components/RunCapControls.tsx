// RunCapControls — pre-emptively raise a cap (budget / max-retries / goal-gate
// / max-loops) on a non-terminal run, without waiting for the matching pause.
//
// RunPausedNotice offers these same raises, but only once the run is already
// paused for that exact reason. The CLI verbs (`fragua runs budget|max-retries
// |goal-gate|max-loops`) have no such gate; this restores parity for the web.
// Since the run isn't paused here, no `resume` is bundled — the raise just
// lifts the ceiling the next turn-boundary check consults.
//
// The public component self-hides on terminal / imported runs; the hook-heavy
// body lives in RunCapControlsInner so Rules-of-Hooks stay satisfied.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { useId, useState } from "react";
import { adjustBudget, adjustGoalGate, adjustMaxLoops, adjustMaxRetries, type RunDetail } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import { toast, toastError } from "../lib/toast.ts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

type CapKind = "budget_cost" | "budget_tokens" | "max_loops" | "goal_gate" | "max_retries";

const CAP_META: Record<CapKind, { menuLabel: string; title: string; description: string; unit: string }> = {
  budget_cost: {
    menuLabel: "Budget — run cost",
    title: "Raise run cost budget",
    description: "Lift the run's USD ceiling. The next turn-boundary check uses the new limit.",
    unit: "new cost limit ($)",
  },
  budget_tokens: {
    menuLabel: "Budget — run tokens",
    title: "Raise run token budget",
    description: "Lift the run's token ceiling. The next turn-boundary check uses the new limit.",
    unit: "new token limit",
  },
  max_loops: {
    menuLabel: "Max loops",
    title: "Raise max loops",
    description: "Lift the per-run dispatch ceiling. Permanently extends how many dispatches the run may make.",
    unit: "new max_loops",
  },
  goal_gate: {
    menuLabel: "Goal-gate retries",
    title: "Raise goal-gate retries",
    description: "Lift the goal-gate retarget-cycle cap.",
    unit: "new max_goal_gate_retries",
  },
  max_retries: {
    menuLabel: "Node max retries",
    title: "Raise a node's max retries",
    description: "Lift a single node's retry cap. Pick the node, then the new limit.",
    unit: "new max_retries",
  },
};

export type RunCapControlsRun = Pick<RunDetail, "status" | "runStatus" | "imported" | "nodes">;

export function RunCapControls({
  runId,
  run,
  _testInitialOpenCap,
}: {
  runId: string;
  run: RunCapControlsRun;
  /** @internal test-only: open a cap dialog on mount, bypassing the dropdown. */
  _testInitialOpenCap?: CapKind | null;
}): JSX.Element | null {
  const nonTerminal = run.status === "queued" || run.status === "running" || run.status === "paused";
  if (run.imported || !nonTerminal) return null;
  return <RunCapControlsInner runId={runId} run={run} initialOpenCap={_testInitialOpenCap ?? null} />;
}

function RunCapControlsInner({
  runId,
  run,
  initialOpenCap,
}: {
  runId: string;
  run: RunCapControlsRun;
  initialOpenCap: CapKind | null;
}): JSX.Element {
  const qc = useQueryClient();
  const [openCap, setOpenCap] = useState<CapKind | null>(initialOpenCap);
  const [initialNodeId] = useState<string>(() =>
    initialOpenCap === "max_retries" ? (Array.from(new Set(run.nodes.map((n) => n.nodeId)))[0] ?? "") : "",
  );
  const [draft, setDraft] = useState<string>("");
  const [nodeId, setNodeId] = useState<string>(initialNodeId);

  const invalidate = (): Promise<void> => qc.invalidateQueries(queries.runs.detail(runId));

  const budgetM = useMutation({
    mutationFn: (input: { metric: "cost" | "tokens"; newLimit: number }) =>
      adjustBudget(runId, "run", input.metric, input.newLimit),
    onSuccess: (_, input) => {
      toast.success(`Run ${input.metric} budget raised`);
      setOpenCap(null);
      return invalidate();
    },
    onError: (err) => toastError(err),
  });
  const maxLoopsM = useMutation({
    mutationFn: (newLimit: number) => adjustMaxLoops(runId, newLimit),
    onSuccess: (_, newLimit) => {
      toast.success(`Max loops set to ${newLimit}`);
      setOpenCap(null);
      return invalidate();
    },
    onError: (err) => toastError(err),
  });
  const goalGateM = useMutation({
    mutationFn: (newLimit: number) => adjustGoalGate(runId, newLimit),
    onSuccess: (_, newLimit) => {
      toast.success(`Goal-gate retries set to ${newLimit}`);
      setOpenCap(null);
      return invalidate();
    },
    onError: (err) => toastError(err),
  });
  const maxRetriesM = useMutation({
    mutationFn: (input: { nodeId: string; newLimit: number }) => adjustMaxRetries(runId, input.nodeId, input.newLimit),
    onSuccess: (_, input) => {
      toast.success(`Max retries for ${input.nodeId} set to ${input.newLimit}`);
      setOpenCap(null);
      return invalidate();
    },
    onError: (err) => toastError(err),
  });

  const busy = budgetM.isPending || maxLoopsM.isPending || goalGateM.isPending || maxRetriesM.isPending;

  // Unique node ids for the max_retries picker — a looping node appears once
  // per iteration in `nodes`, but the cap is per node identity.
  const nodeIds = Array.from(new Set(run.nodes.map((n) => n.nodeId)));

  function openDialog(kind: CapKind): void {
    setDraft("");
    setNodeId(kind === "max_retries" ? (nodeIds[0] ?? "") : "");
    setTimeout(() => setOpenCap(kind), 0);
  }

  const parsed = Number(draft);
  const positive = Number.isFinite(parsed) && parsed > 0;
  const canSubmit = openCap === "max_retries" ? positive && nodeId.length > 0 : positive;

  function submit(): void {
    if (!canSubmit || openCap === null) return;
    if (openCap === "budget_cost") budgetM.mutate({ metric: "cost", newLimit: parsed });
    else if (openCap === "budget_tokens") budgetM.mutate({ metric: "tokens", newLimit: parsed });
    else if (openCap === "max_loops") maxLoopsM.mutate(parsed);
    else if (openCap === "goal_gate") goalGateM.mutate(parsed);
    else if (openCap === "max_retries") maxRetriesM.mutate({ nodeId, newLimit: parsed });
  }

  const meta = openCap ? CAP_META[openCap] : null;
  const nodeSelectId = useId();
  const limitInputId = useId();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            className="h-5 px-1.5 text-[0.65rem]"
            data-testid={`run-cap-trigger-${runId}`}
          >
            <Gauge className="size-3" />
            Raise cap
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(Object.keys(CAP_META) as CapKind[]).map((kind) => (
            <DropdownMenuItem
              key={kind}
              data-testid={`run-cap-item-${kind}`}
              disabled={kind === "max_retries" && nodeIds.length === 0}
              onSelect={() => openDialog(kind)}
            >
              {CAP_META[kind].menuLabel}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={openCap !== null} onOpenChange={(open) => !open && !busy && setOpenCap(null)}>
        <AlertDialogContent data-testid="run-cap-dialog">
          {meta && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{meta.title}</AlertDialogTitle>
                <AlertDialogDescription>{meta.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-3">
                {openCap === "max_retries" && (
                  <div className="flex items-center gap-2 text-sw-xs text-sw-muted">
                    <label htmlFor={nodeSelectId} className="shrink-0">
                      node
                    </label>
                    <Select value={nodeId} onValueChange={setNodeId}>
                      <SelectTrigger
                        id={nodeSelectId}
                        size="sm"
                        className="font-mono"
                        data-testid="run-cap-node-select"
                      >
                        <SelectValue placeholder="pick a node" />
                      </SelectTrigger>
                      <SelectContent>
                        {nodeIds.map((id) => (
                          <SelectItem key={id} value={id} data-testid={`run-cap-node-option-${id}`}>
                            {id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sw-xs text-sw-muted">
                  <label htmlFor={limitInputId} className="shrink-0">
                    {meta.unit}
                  </label>
                  <Input
                    id={limitInputId}
                    type="number"
                    inputMode="decimal"
                    step={openCap === "budget_cost" ? "0.01" : "1"}
                    min="0"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    data-testid="run-cap-input"
                    className="w-28"
                  />
                </div>
              </div>
              <AlertDialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => setOpenCap(null)}
                  data-testid="run-cap-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  disabled={busy || !canSubmit}
                  onClick={submit}
                  data-testid="run-cap-confirm"
                >
                  Raise
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

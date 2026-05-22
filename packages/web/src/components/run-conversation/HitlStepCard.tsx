// HitlStepCard — inline HITL gate rendered inside the conversation flow.
//
// Appears at the tail of the node section that owns the paused human node.
// Shows the operator-facing question and one button per declared route,
// reusing the same POST shape as HitlChoice (intent.human_input via
// /runs/:id/human). The card only renders when the run is paused_human;
// once the operator picks a route the run resumes and this card disappears.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCheckIcon } from "lucide-react";
import { useState } from "react";
import { submitHitlChoice } from "../../lib/api.ts";
import { humanizeRouteName } from "../../lib/humanize.ts";
import { queries } from "../../lib/queries.ts";
import { toastError } from "../../lib/toast.ts";
import { Button } from "../ui/button.tsx";

export interface HitlStepCardProps {
  runId: string;
  /** Operator-facing question from the human node's `text=` attr. */
  label: string | null;
  /** Declared route names; one button rendered per entry. */
  options: string[];
  /** Sparse route-name → button-text overrides (workflow edge `label=`).
   * Routes absent here fall back to `humanizeRouteName`. */
  optionLabels?: Record<string, string>;
}

export function HitlStepCard({ runId, label, options, optionLabels }: HitlStepCardProps): JSX.Element | null {
  const [note, setNote] = useState("");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (route: string) => submitHitlChoice(runId, route, note.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queries.runs.all() });
    },
    onError: (err) => toastError(err),
  });

  if (options.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-3 rounded-[var(--sw-radius-default)] border px-[var(--sw-space-3)] py-[var(--sw-space-3)]"
      style={{
        borderColor: "color-mix(in oklch, var(--sw-accent-pause-hitl) 35%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--sw-accent-pause-hitl) 6%, transparent)",
      }}
      data-testid="hitl-step-card"
    >
      <div className="flex items-center gap-[var(--sw-space-2)]">
        <UserCheckIcon className="size-4 shrink-0" style={{ color: "var(--sw-accent-pause-hitl)" }} aria-hidden />
        <span
          className="font-medium uppercase tracking-[0.06em] text-[length:var(--sw-text-xs)]"
          style={{ color: "var(--sw-accent-pause-hitl)" }}
        >
          Needs input
        </span>
      </div>

      {label && (
        <p className="text-[length:var(--sw-text-sm)] text-[var(--sw-text)]" data-testid="hitl-step-label">
          {label}
        </p>
      )}

      <div className="flex flex-wrap gap-2" data-testid="hitl-step-options">
        {options.map((route) => (
          <Button
            key={route}
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(route)}
            data-testid={`hitl-step-${route.toLowerCase()}`}
          >
            {optionLabels?.[route] ?? humanizeRouteName(route)}
          </Button>
        ))}
      </div>

      <textarea
        className="min-h-[64px] w-full resize-y rounded border border-sw-border bg-sw-bg px-3 py-2 text-sw-sm text-sw-text placeholder:text-sw-muted focus:border-sw-accent-idle focus:outline-none disabled:opacity-50"
        placeholder="Notes (optional) — recorded with the resume event for audit"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={mutation.isPending}
        data-testid="hitl-step-note"
      />

      {mutation.isError && (
        <p
          className="text-[length:var(--sw-text-xs)]"
          style={{ color: "var(--sw-accent-error)" }}
          data-testid="hitl-step-error"
        >
          {mutation.error instanceof Error ? mutation.error.message : "Failed to submit"}
        </p>
      )}
    </div>
  );
}

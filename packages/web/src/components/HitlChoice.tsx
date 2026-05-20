// HitlChoice — structured operator input for a paused human node.
//
// Renders the question text, one button per declared route, and an
// optional freeform notes textarea. The note rides inside the
// intent.human_input payload for audit but does not influence routing.
// Button labels derive from a humanized form of the route name; per-edge
// label overrides (proposal §D6) layer in via the optional
// `routeLabels` map when callers have them.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { submitHitlChoice } from "../lib/api.ts";
import { humanizeRouteName } from "../lib/humanize.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";

export interface HitlChoiceProps {
  runId: string;
  /** Operator-facing question from the human node's `text=` attr.
   *  Surfaced via `RunDetail.hitlLabel`. */
  label?: string | null;
  /** Declared route names from the node's `routes=` attr; one button each.
   *  Surfaced via `RunDetail.hitlOptions`. */
  options: string[];
  /** Optional per-route button label override (from the outgoing edge's
   *  `label=` attr). Keys are route names. */
  routeLabels?: Record<string, string>;
}

export function HitlChoice({ runId, label, options, routeLabels }: HitlChoiceProps): JSX.Element | null {
  const [note, setNote] = useState("");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (route: string) => submitHitlChoice(runId, route, note.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queries.runs.all() });
    },
  });

  if (options.length === 0) return null;

  return (
    <div
      className="rounded-sw-card border border-sw-accent-human/40 bg-sw-surface p-4 flex flex-col gap-3"
      data-testid="hitl-choice"
    >
      <p className="text-sw-sm font-medium text-sw-text" data-testid="hitl-choice-label">
        {label ?? "Select an option:"}
      </p>

      <div className="flex flex-wrap gap-2" data-testid="hitl-choice-options">
        {options.map((route) => {
          const override = routeLabels?.[route]?.trim();
          return (
            <Button
              key={route}
              variant="outline"
              size="sm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(route)}
              data-testid={`hitl-choice-${route.toLowerCase()}`}
            >
              {override && override.length > 0 ? override : humanizeRouteName(route)}
            </Button>
          );
        })}
      </div>

      <textarea
        className="min-h-[64px] w-full resize-y rounded border border-sw-border bg-sw-bg px-3 py-2 text-sw-sm text-sw-text placeholder:text-sw-muted focus:border-sw-accent-idle focus:outline-none disabled:opacity-50"
        placeholder="Notes (optional) — recorded with the resume event for audit"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={mutation.isPending}
        data-testid="hitl-choice-note"
      />

      {mutation.isError && (
        <p className="text-sw-xs text-sw-accent-error" data-testid="hitl-choice-error">
          {mutation.error instanceof Error ? mutation.error.message : "Failed to submit"}
        </p>
      )}
    </div>
  );
}

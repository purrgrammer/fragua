// HitlChoice — structured operator input for a paused human node.
//
// Renders the question label, one button per route, and an optional
// freeform notes textarea. Notes are recorded in the intent.human_input
// event payload for audit; they don't flow to downstream nodes via
// routing. Button label uses the per-edge label when present; falls back
// to a humanized form of the route key (titleCaseFromSnake).

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { submitHitlChoice } from "../lib/api.ts";
import { humanizeRouteName } from "../lib/humanize.ts";
import { queries } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";

export interface HitlOption {
  key: string;
  label: string;
  to: string;
}

export interface HitlChoiceProps {
  runId: string;
  label?: string | null;
  options: HitlOption[];
}

export function HitlChoice({ runId, label, options }: HitlChoiceProps): JSX.Element | null {
  const [note, setNote] = useState("");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: (selected: string) => submitHitlChoice(runId, selected, note.trim() || undefined),
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
        {options.map((opt) => (
          <Button
            key={opt.key}
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(opt.key)}
            data-testid={`hitl-choice-${opt.key.toLowerCase()}`}
          >
            {opt.label.trim().length > 0 ? opt.label : humanizeRouteName(opt.key)}
          </Button>
        ))}
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

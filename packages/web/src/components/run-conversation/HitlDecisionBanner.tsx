// HitlDecisionBanner — the operator's recorded answer to a HITL gate.
//
// Rendered inside the node section that owned the human gate once the run
// has moved past it (the gate is closed, but the decision stays visible).
// Sourced from the durable event log (`intent.human_input`), so it shows
// on reload and for any observer — not just the operator who answered.

import { CheckCheckIcon } from "lucide-react";
import { humanizeRouteName } from "../../lib/humanize.ts";

export interface HitlDecisionBannerProps {
  route: string;
  note?: string;
}

export function HitlDecisionBanner({ route, note }: HitlDecisionBannerProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--sw-radius-default)] border px-3 py-3"
      style={{
        borderColor: "color-mix(in oklch, var(--sw-accent-success) 30%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--sw-accent-success) 5%, transparent)",
      }}
      data-testid="hitl-decision-banner"
    >
      <div className="flex items-center gap-2">
        <CheckCheckIcon className="size-4 shrink-0" style={{ color: "var(--sw-accent-success)" }} aria-hidden />
        <span
          className="font-medium uppercase tracking-[0.06em] text-[length:var(--sw-text-xs)]"
          style={{ color: "var(--sw-accent-success)" }}
        >
          Responded
        </span>
        <span
          className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-text)]"
          data-testid="hitl-decision-route"
        >
          {humanizeRouteName(route)}
        </span>
      </div>
      {note && (
        <p className="text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]" data-testid="hitl-decision-note">
          {note}
        </p>
      )}
    </div>
  );
}

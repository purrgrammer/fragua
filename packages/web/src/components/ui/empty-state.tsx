// Reusable empty / graceful-error state. Used whenever a fetch returns
// nothing meaningful (404, 500, empty list) and we'd rather show a
// purpose-built card than leak a stack trace to the user.
//
// Design (Swarm — .agents/skills/design/SKILL.md):
//   § Borders & elevation — "1px only, `border` token", "Radius … 4px
//                           cards/drawers". Solid hairline, no dashed
//                           ornament; dashed read as a decorative cue
//                           that violates "data as decor."
//   § Anti-patterns        — "Background shade for hierarchy → same
//                           surface, hairline." We sit on --sw-surface,
//                           not a tinted muted variant.
//   § Layout               — "Consistent padding inside every cell."
//                           Padding snaps to --sw-space-4 (panel
//                           padding token).
//   § Typography           — monospace inherited; hierarchy via weight,
//                           never size jumps. Title uses --sw-text-base
//                           weight 500; description uses --sw-text-sm
//                           in --sw-muted.
//   § Color                — only --sw-* tokens; muted carries
//                           secondary info, no opacity dimming steps.
//
// Real errors (caught in the parent) should be `console.warn`'d by the
// caller before rendering this; the UI stays clean while devs keep full
// diagnostics in the console.
//
// A note on `role="status"` vs `<output>`:
//   Biome's `useSemanticElements` rule suggests `<output>` for
//   role="status". `<output>` is form-oriented (it lives inside a form
//   and represents a calculation result); this card is a generic
//   empty/error state that is not tied to a form. `role="status"` on a
//   `<div>` is the established ARIA pattern for non-form live regions,
//   so we suppress the rule at the opening tag.

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export interface EmptyStateProps {
  /** Short headline, e.g. "No graph available". */
  title: string;
  /** Supporting copy, e.g. the run id. Rendered below the title. */
  description?: ReactNode;
  /** Optional icon element — typically a `lucide-react` icon. */
  icon?: ReactNode;
  /** Optional action node (button, link) placed under the description. */
  action?: ReactNode;
  /** Extra classes appended to the container. */
  className?: string;
  /** Lets tests disambiguate multiple empty states on one page. */
  "data-testid"?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  "data-testid": testId = "empty-state",
}: EmptyStateProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      role="status"
      className={cn(
        // Layout: bento cell, content-driven; min-height matches the
        // graph container baseline so swapping in an empty state doesn't
        // cause the page to snap shorter. The 240px figure is a layout
        // contract with GraphView, not a spacing decision — it lives
        // outside the spacing token scale by design.
        "flex min-h-[240px] w-full flex-col items-center justify-center text-center",
        "gap-[var(--sw-space-2)] p-[var(--sw-space-4)]",
        // Surface + hairline (no shadow, no dashed ornament, no tinted bg)
        "bg-[var(--sw-surface)] text-[var(--sw-muted)]",
        "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
        className,
      )}
    >
      {icon && (
        <div className="text-[var(--sw-muted)]" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="font-medium text-[var(--sw-text)] text-[length:var(--sw-text-base)]">{title}</p>
      {description && <div className="text-[var(--sw-muted)] text-[length:var(--sw-text-sm)]">{description}</div>}
      {action && <div className="mt-[var(--sw-space-1)]">{action}</div>}
    </div>
  );
}

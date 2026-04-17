// Reusable empty / graceful-error state. Used whenever a fetch returns
// nothing meaningful (404, 500, empty list) and we'd rather show a
// purpose-built card than leak a stack trace to the user.
//
// Design:
//   - Muted, card-like container sized to fill its parent (min-height
//     keeps the layout from collapsing to a single line).
//   - Optional icon slot — callers pass a `lucide-react` icon element.
//   - `title` is required; `description` is optional but encouraged.
//   - An optional `action` slot for a retry button etc. — kept as a
//     generic ReactNode so we don't couple to `<Button>` here.
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
    // biome-ignore lint/a11y/useSemanticElements: <output> is form-oriented; role="status" on a div is the correct ARIA pattern for a generic empty/error card.
    <div
      data-testid={testId}
      role="status"
      className={cn(
        // `min-h-[240px]` matches the graph container baseline so swapping
        // in an empty state doesn't cause the page to snap shorter.
        "flex min-h-[240px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-8 text-center text-muted-foreground",
        className,
      )}
    >
      {icon && (
        <div className="text-muted-foreground/70" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <div className="text-xs text-muted-foreground">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

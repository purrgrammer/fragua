// Reusable empty / graceful-error state. The single primitive every
// section reaches for when a fetch returned nothing meaningful, when a
// list is empty, or when a graceful "all clear" message is the answer.
//
// Two densities, both on `bg-sw-surface` with a solid hairline (no
// dashed ornament — dashed reads as decorative). Hierarchy comes from
// the hairline, not from a tinted bg.
//
//   density="default"  full bento card  icon-on-top + title + description
//   density="compact"  inline strip     icon-left + title (description optional)
//
// Compact density is for the secondary "calm" empty states that sit
// between populated sections (e.g. an Inbox that has nothing in it on
// the Control Center). Default density is for stand-alone empty states
// that own their region (e.g. "Nothing running" on the dashboard, the
// graph-load failure card on RunDetail).
//
// Real errors caught upstream should be `console.warn`'d by the caller
// before rendering this; the UI stays clean while devs keep full
// diagnostics in the console.
//
// `role="status"` on a `<div>` is the established ARIA pattern for
// non-form live regions; Biome's `useSemanticElements` rule prefers
// `<output>` but that element is form-oriented, so we suppress here.

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type EmptyStateDensity = "default" | "compact";

export interface EmptyStateProps {
  /** Short headline. */
  title: string;
  /** Supporting copy. In `compact` density it sits on the right of the strip. */
  description?: ReactNode;
  /** Optional icon — typically a `lucide-react` icon. */
  icon?: ReactNode;
  /** Optional action node (button, link). */
  action?: ReactNode;
  /** `compact` renders an inline strip; `default` renders the full bento card. */
  density?: EmptyStateDensity;
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
  density = "default",
  className,
  "data-testid": testId = "empty-state",
}: EmptyStateProps): JSX.Element {
  const surface = "bg-sw-surface text-sw-muted border border-sw-border rounded-sw-card";

  if (density === "compact") {
    return (
      <div
        data-testid={testId}
        role="status"
        className={cn("flex items-center gap-3 px-3 py-3 text-sw-sm", surface, className)}
      >
        {icon && (
          <span className="shrink-0" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sw-muted">{title}</span>
        {description && <span className="shrink-0 text-sw-muted">{description}</span>}
        {action && <span className="shrink-0">{action}</span>}
      </div>
    );
  }

  return (
    <div
      data-testid={testId}
      role="status"
      className={cn(
        // 240px min-height matches the GraphView container baseline so
        // swapping in an empty state doesn't snap the page shorter.
        "flex min-h-[240px] w-full flex-col items-center justify-center text-center",
        "gap-2 p-4",
        surface,
        className,
      )}
    >
      {icon && (
        <div className="text-sw-muted" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="font-medium text-sw-text text-sw-base">{title}</p>
      {description && <div className="text-sw-muted text-sw-sm">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

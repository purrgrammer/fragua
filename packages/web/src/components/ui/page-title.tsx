// Page title — exactly one per route, renders an <h1> at text-sw-lg.
// Wraps the right-side action slot for per-page actions (filters, view
// toggles, etc.). Section titles within a route use <SectionTitle>.
//
// Hierarchy is weight + size on the heading, not the chrome around it —
// no surface, no border, no shadow. The line below the title is the
// natural `gap-*` of the parent flex column, not a divider.

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export interface PageTitleProps {
  children: ReactNode;
  /** Right-aligned slot — typically a button or a link. */
  action?: ReactNode;
  className?: string;
}

export function PageTitle({ children, action, className }: PageTitleProps): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <h1 className="font-medium text-sw-lg leading-[1.2] text-sw-text">{children}</h1>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

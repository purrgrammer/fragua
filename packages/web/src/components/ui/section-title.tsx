// Section title — renders an <h2> at text-sw-md for bento sections
// inside a route ("Inbox", "Running", "Activity"). Optional action slot
// folds in the per-section affordance ("View all →", filter dropdown,
// etc.) so each section header doesn't hand-roll the same flex row.

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export interface SectionTitleProps {
  children: ReactNode;
  /** Right-aligned slot — typically a "View all →" link. */
  action?: ReactNode;
  className?: string;
}

export function SectionTitle({ children, action, className }: SectionTitleProps): JSX.Element {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <h2 className="font-medium text-sw-md leading-[1.2] text-sw-text">{children}</h2>
      {action ? <div className="shrink-0 text-sw-xs">{action}</div> : null}
    </div>
  );
}

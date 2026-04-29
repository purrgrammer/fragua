// Shared bento card chrome for an analytics chart. Header carries the
// metric identity (icon + label) on the left and the headline value
// (total + delta) on the right; body is a fixed-height chart slot.
//
// The chart itself is rendered through `<ChartContainer>` (shadcn
// chart) inside `body` — keep the card to layout/labels and let the
// chart own its responsive sizing.

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

export interface ChartCardProps {
  title: string;
  /** Small icon next to the title (muted, aria-hidden). */
  icon?: ReactNode;
  /** Right-aligned headline — typically the metric total + delta.
   *  Wins over `caption` when both are provided. */
  headerRight?: ReactNode;
  /** Right-aligned secondary label — units, scope hints. Used by the
   *  donut/bar cards that don't carry a numeric headline. */
  caption?: string;
  /** Pixel height for the chart body. Keeps cards from jumping. */
  height?: number;
  loading?: boolean;
  /** When `true` and not loading, renders the EmptyState in place of children. */
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  children: ReactNode;
}

export function ChartCard({
  title,
  icon,
  headerRight,
  caption,
  height = 220,
  loading = false,
  empty = false,
  emptyMessage = "No data in this window.",
  className,
  children,
}: ChartCardProps): JSX.Element {
  return (
    <Card size="sm" className={`gap-0 py-0 ring-0 ${className ?? ""}`}>
      <CardHeader className="border-b px-[var(--sw-space-4)] pt-[var(--sw-space-2)] pb-[var(--sw-space-3)]">
        {/* Fixed row height matches the AnimatedNumber's leading-none
            text-2xl line so every chart header — total or no total —
            ends up exactly the same height. */}
        <CardTitle className="flex h-[1.5rem] items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sw-base font-medium text-sw-text">
            {icon ? (
              <span aria-hidden="true" className="text-sw-muted">
                {icon}
              </span>
            ) : null}
            <span>{title}</span>
          </span>
          {headerRight ?? (caption ? <span className="text-sw-xs text-sw-muted">{caption}</span> : null)}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-[var(--sw-space-4)]">
        <div style={{ height }} className="w-full">
          {loading ? (
            <Skeleton className="size-full" />
          ) : empty ? (
            <div className="flex size-full items-center justify-center">
              <EmptyState density="compact" title={emptyMessage} />
            </div>
          ) : (
            children
          )}
        </div>
      </CardContent>
    </Card>
  );
}

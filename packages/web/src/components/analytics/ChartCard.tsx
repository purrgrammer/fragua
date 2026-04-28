// Shared bento card chrome for an analytics chart. One title row,
// optional caption, and a fixed-height body so different chart types
// don't make the bento jump as data changes.
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
  /** Optional sentence under the title — units, scope hints. */
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
  caption,
  height = 220,
  loading = false,
  empty = false,
  emptyMessage = "No data in this window.",
  className,
  children,
}: ChartCardProps): JSX.Element {
  return (
    <Card size="sm" className={`ring-0 ${className ?? ""}`}>
      <CardHeader>
        <CardTitle className="flex items-baseline justify-between gap-2 text-sw-xs font-medium text-sw-muted uppercase tracking-wider">
          <span>{title}</span>
          {caption ? <span className="text-sw-xs normal-case tracking-normal text-sw-muted">{caption}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
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

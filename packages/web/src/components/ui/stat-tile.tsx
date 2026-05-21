// StatTile — one bento cell of a stats strip. Shared across Home's
// global dashboard and the RunDetail header so the design language
// stays coherent.
//
// Layout matches the Fragua design skill: no shadow (global reset),
// hairline border via Card, tabular figures, subdued label text,
// single big numeric/value line. Supports three input modes:
//
//   - numericValue + format  → AnimatedNumber (preferred for live stats)
//   - value (string)         → static pre-formatted text
//   - children               → arbitrary content (badge, pill, etc.)
//
// `hint` shows up as a hover title with secondary context.

import type { ReactNode } from "react";
import { AnimatedNumber } from "./animated-number.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { Skeleton } from "./skeleton.tsx";

export interface StatTileProps {
  label: string;
  /** `true` renders a Skeleton; the only trigger. `undefined` values
   * with `loading=false` fall through to "—". */
  loading?: boolean;
  /** Animated numeric path. Preferred for anything that updates live. */
  numericValue?: number;
  /** Number-format options. Required when `numericValue` is set. */
  format?: Intl.NumberFormatOptions;
  /** Pre-formatted static text. Mutually exclusive with `numericValue`. */
  value?: string;
  /** Arbitrary content (Badge, status pill, etc.). Wins over
   * `numericValue`/`value` when provided. */
  children?: ReactNode;
  /** Hover title — secondary context. */
  hint?: string;
  /** Optional icon in the title row (muted, aria-hidden). */
  icon?: ReactNode;
  testId?: string;
}

export function StatTile({
  label,
  loading = false,
  numericValue,
  format,
  value,
  children,
  hint,
  icon,
  testId,
}: StatTileProps): JSX.Element {
  return (
    <Card size="sm" data-testid={testId} className="ring-0" title={hint}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sw-xs font-medium text-sw-muted">
          <span>{label}</span>
          {icon ? <span aria-hidden="true">{icon}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Reserve a fixed line-height block whether the value is a
            skeleton, a number, or a fallback dash. The `text-2xl
            tabular-nums` line-height is ~2rem (32px); pinning the
            content row to `h-8` keeps the tile from changing height
            when the skeleton swaps for the real number, which used
            to be the visible "no number → number" reflow. */}
        <div className="flex h-8 items-center">
          {loading ? (
            <Skeleton className="h-7 w-20" />
          ) : children !== undefined ? (
            <div className="font-heading text-2xl leading-none tabular-nums">{children}</div>
          ) : numericValue !== undefined || format !== undefined ? (
            <AnimatedNumber
              value={numericValue}
              format={format}
              className="font-heading text-2xl leading-none tabular-nums"
            />
          ) : (
            <p className="font-heading text-2xl leading-none tabular-nums">{value ?? "—"}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

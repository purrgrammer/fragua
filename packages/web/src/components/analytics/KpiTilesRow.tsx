// KPI strip across the top of /analytics. Uses the shared `StatTile`
// primitive so the chrome (border, padding, label weight, icon slot)
// matches Control Center exactly. Each tile carries an inline
// percentage delta vs the previous window — no separate caption row,
// the window selector communicates the comparison context.
//
// Tokens KPI counts only fresh tokens (input + output), mirroring the
// Control Center "Tokens" tile. Cache reads/writes are surfaced by
// the dedicated Cache KPI and the Cache time-series chart.
//
// Loading state: when `current` is null we pass `undefined` numeric
// values to AnimatedNumber so it renders the "—" placeholder instead
// of animating from 0 → real value on the first payload.
//
// `NumberFlowGroup` wraps the main number and the delta percentage so
// their digit transitions tick in lockstep on every refresh — without
// it, the two NumberFlow instances animate on independent frames and
// the strip looks shimmery.

import { NumberFlowGroup } from "@number-flow/react";
import { Coins, Database, DollarSign, type LucideIcon, Play } from "lucide-react";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "@/lib/format";
import type { AnalyticsTotals } from "@/types/analytics";
import { AnimatedNumber } from "../ui/animated-number.tsx";
import { StatTile } from "../ui/stat-tile.tsx";
import { ComparisonDelta } from "./ComparisonDelta.tsx";

export interface KpiTilesRowProps {
  /** `null` while the first payload is in flight — tiles render `"—"`. */
  current: AnalyticsTotals | null;
  previous: AnalyticsTotals | null;
}

interface Tile {
  label: string;
  icon: LucideIcon;
  /** `undefined` ⇒ AnimatedNumber renders the loading placeholder. */
  current: number | undefined;
  previous: number | null;
  format: Intl.NumberFormatOptions;
  /** When `'inverse'`, increases render as negative tone (spend). */
  direction?: "normal" | "inverse";
  testId: string;
}

export function KpiTilesRow({ current, previous }: KpiTilesRowProps): JSX.Element {
  const cacheHitRate = current ? computeCacheHitRate(current.inputTokens, current.cacheReadTokens) : null;
  const previousCacheHitRate = previous ? computeCacheHitRate(previous.inputTokens, previous.cacheReadTokens) : null;
  const freshTokens = current ? current.inputTokens + current.outputTokens : undefined;
  const previousFreshTokens = previous ? previous.inputTokens + previous.outputTokens : null;

  const tiles: Tile[] = [
    {
      label: "Runs",
      icon: Play,
      current: current?.runs,
      previous: previous?.runs ?? null,
      format: { notation: "compact", maximumFractionDigits: 1 },
      testId: "kpi-runs",
    },
    {
      label: "Spend",
      icon: DollarSign,
      current: current?.costUsd,
      previous: previous?.costUsd ?? null,
      format: usdFormatOptions(current?.costUsd ?? 0),
      direction: "inverse",
      testId: "kpi-spend",
    },
    {
      label: "Tokens",
      icon: Coins,
      current: freshTokens,
      previous: previousFreshTokens,
      format: tokensCompactFormatOptions(freshTokens ?? 0),
      direction: "inverse",
      testId: "kpi-tokens",
    },
    {
      label: "Cache",
      icon: Database,
      current: cacheHitRate ?? undefined,
      previous: previousCacheHitRate,
      format: percentFormatOptions(),
      testId: "kpi-cache",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <StatTile key={t.label} label={t.label} icon={<Icon className="size-4" />} testId={t.testId}>
            <NumberFlowGroup>
              <span className="inline-flex items-center gap-2">
                <AnimatedNumber value={t.current} format={t.format} />
                <ComparisonDelta current={t.current} previous={t.previous} direction={t.direction} />
              </span>
            </NumberFlowGroup>
          </StatTile>
        );
      })}
    </div>
  );
}

/** Cache hit rate as a 0–1 ratio. Mirrors `formatCacheHitRate` semantics
 *  but returns the numeric ratio so AnimatedNumber can animate it. */
function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number | null {
  const denom = inputTokens + cacheReadTokens;
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return cacheReadTokens / denom;
}

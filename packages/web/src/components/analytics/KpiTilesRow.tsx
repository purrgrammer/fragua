// KPI strip across the top of /analytics. Uses the shared `StatTile`
// primitive so the chrome (border, padding, label weight, icon slot)
// matches Control Center exactly. Each tile carries an inline
// percentage delta vs the previous window — no separate caption row,
// the window selector communicates the comparison context.

import { Coins, Database, DollarSign, type LucideIcon, Play } from "lucide-react";
import { percentFormatOptions, tokensCompactFormatOptions, usdFormatOptions } from "@/lib/format";
import type { AnalyticsTotals } from "@/types/analytics";
import { AnimatedNumber } from "../ui/animated-number.tsx";
import { StatTile } from "../ui/stat-tile.tsx";
import { ComparisonDelta } from "./ComparisonDelta.tsx";

export interface KpiTilesRowProps {
  current: AnalyticsTotals;
  previous: AnalyticsTotals | null;
}

interface Tile {
  label: string;
  icon: LucideIcon;
  current: number;
  previous: number | null;
  format: Intl.NumberFormatOptions;
  /** When `'inverse'`, increases render as negative tone (spend). */
  direction?: "normal" | "inverse";
  testId: string;
}

export function KpiTilesRow({ current, previous }: KpiTilesRowProps): JSX.Element {
  const cacheHitRate = computeCacheHitRate(current.inputTokens, current.cacheReadTokens);
  const previousCacheHitRate = previous ? computeCacheHitRate(previous.inputTokens, previous.cacheReadTokens) : null;

  const tiles: Tile[] = [
    {
      label: "Runs",
      icon: Play,
      current: current.runs,
      previous: previous?.runs ?? null,
      format: { notation: "compact", maximumFractionDigits: 1 },
      testId: "kpi-runs",
    },
    {
      label: "Spend",
      icon: DollarSign,
      current: current.costUsd,
      previous: previous?.costUsd ?? null,
      format: usdFormatOptions(current.costUsd),
      direction: "inverse",
      testId: "kpi-spend",
    },
    {
      label: "Tokens",
      icon: Coins,
      current: current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheWriteTokens,
      previous: previous
        ? previous.inputTokens + previous.outputTokens + previous.cacheReadTokens + previous.cacheWriteTokens
        : null,
      format: tokensCompactFormatOptions(
        current.inputTokens + current.outputTokens + current.cacheReadTokens + current.cacheWriteTokens,
      ),
      direction: "inverse",
      testId: "kpi-tokens",
    },
    {
      label: "Cache hit rate",
      icon: Database,
      current: cacheHitRate ?? 0,
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
            <span className="inline-flex items-baseline gap-2">
              <AnimatedNumber value={t.current} format={t.format} />
              <ComparisonDelta current={t.current} previous={t.previous} direction={t.direction} />
            </span>
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

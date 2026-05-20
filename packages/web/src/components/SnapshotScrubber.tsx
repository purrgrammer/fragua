import type { RunSnapshot } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";

/** Label pill for snapshot type — distinguishes step / hitl / terminal. */
function LabelPill({ label }: { label: RunSnapshot["label"] }): JSX.Element {
  const colour =
    label === "terminal" ? "text-sw-accent-success" : label === "hitl" ? "text-sw-accent-thinking" : "text-sw-muted";
  return (
    <span
      className={cn(
        "shrink-0 rounded border border-sw-border bg-sw-surface px-1 py-px font-mono text-[10px] uppercase tracking-[0.06em]",
        colour,
      )}
    >
      {label}
    </span>
  );
}

/** Compact +N / -N change-stat badges. */
function ChangeStat({ stat, label }: { stat: { additions: number; deletions: number }; label: string }): JSX.Element {
  return (
    <span role="img" className="flex shrink-0 items-center gap-1 font-mono text-[10px]" aria-label={label}>
      {stat.additions > 0 && <span className="text-sw-accent-success">+{stat.additions}</span>}
      {stat.deletions > 0 && <span className="text-sw-accent-error">-{stat.deletions}</span>}
    </span>
  );
}

export interface SnapshotScrubberProps {
  snapshots: RunSnapshot[];
  selectedEventIdx: number;
  onSelect: (eventIdx: number) => void;
}

export function SnapshotScrubber({ snapshots, selectedEventIdx, onSelect }: SnapshotScrubberProps): JSX.Element {
  return (
    <nav
      aria-label="Snapshot timeline"
      className="flex min-h-0 flex-col overflow-y-auto"
      data-testid="snapshot-scrubber"
    >
      {snapshots.map((snap) => {
        const isSelected = snap.eventIdx === selectedEventIdx;
        const label = snap.nodeId ? `${snap.nodeId} · #${snap.eventIdx}` : `#${snap.eventIdx}`;
        const stat = snap.committed ?? snap.uncommitted ?? null;

        return (
          <button
            key={snap.eventIdx}
            type="button"
            data-testid={`snapshot-row-${snap.eventIdx}`}
            aria-pressed={isSelected}
            onClick={() => onSelect(snap.eventIdx)}
            className={cn(
              "flex w-full items-center gap-2 border-b border-sw-border px-3 py-2 text-left transition-colors duration-[var(--sw-duration-hover,120ms)]",
              "hover:bg-sw-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sw-border",
              isSelected ? "bg-sw-surface ring-1 ring-inset ring-sw-border" : "bg-transparent",
            )}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-sw-sm text-sw-text" title={label}>
              {label}
            </span>
            {stat && <ChangeStat stat={stat} label={`${stat.additions} additions, ${stat.deletions} deletions`} />}
            <LabelPill label={snap.label} />
          </button>
        );
      })}
    </nav>
  );
}

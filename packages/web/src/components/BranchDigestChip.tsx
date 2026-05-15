// Compact glyph chip summarising a parent's immediate sub-run statuses.
//
// Renders next to the parent's status badge in lists + detail header so
// operators see at a glance "this parent has 3 branches: 2 done, 1
// paused on budget". Empty digest (no children, all zero) collapses to
// nothing — runs without sub-runs stay clean.
//
// Order is hand-tuned for attention: paused-class first (operator
// action), then in-flight (running/queued), then terminal (completed
// /failed). The component only shows non-zero buckets to keep visual
// weight low.

import type { ChildStatusDigest } from "../lib/api.ts";

export interface BranchDigestChipProps {
  digest: ChildStatusDigest;
  /** Extra classes for the outer chip. */
  className?: string;
}

interface Bucket {
  key: keyof ChildStatusDigest;
  glyph: string;
  tone: string;
  ariaLabel: (n: number) => string;
}

const BUCKETS: ReadonlyArray<Bucket> = [
  {
    key: "pausedHitl",
    glyph: "❓",
    tone: "text-sw-accent-pause-hitl",
    ariaLabel: (n) => `${n} branch${n === 1 ? "" : "es"} awaiting HITL`,
  },
  {
    key: "paused",
    glyph: "⏸",
    tone: "text-sw-accent-pause",
    ariaLabel: (n) => `${n} paused branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "pausedAuto",
    glyph: "◷",
    tone: "text-sw-accent-pause-auto",
    ariaLabel: (n) => `${n} branch${n === 1 ? "" : "es"} retrying`,
  },
  {
    key: "quarantined",
    glyph: "△",
    tone: "text-sw-accent-error",
    ariaLabel: (n) => `${n} quarantined branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "running",
    glyph: "▶",
    tone: "text-sw-accent-thinking",
    ariaLabel: (n) => `${n} running branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "queued",
    glyph: "•",
    tone: "text-sw-accent-idle",
    ariaLabel: (n) => `${n} queued branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "completed",
    glyph: "✓",
    tone: "text-sw-accent-success",
    ariaLabel: (n) => `${n} completed branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "halted",
    glyph: "✕",
    tone: "text-sw-accent-error",
    ariaLabel: (n) => `${n} halted branch${n === 1 ? "" : "es"}`,
  },
  {
    key: "cancelled",
    glyph: "✕",
    tone: "text-sw-muted",
    ariaLabel: (n) => `${n} cancelled branch${n === 1 ? "" : "es"}`,
  },
];

export function BranchDigestChip({ digest, className }: BranchDigestChipProps): JSX.Element | null {
  const slices = BUCKETS.filter((b) => (digest[b.key] as number) > 0);
  if (slices.length === 0) return null;
  const total = digest.total;
  const titleParts: string[] = [`${total} branch${total === 1 ? "" : "es"}`];
  for (const b of slices) {
    const n = digest[b.key] as number;
    titleParts.push(b.ariaLabel(n));
  }
  return (
    <span
      title={titleParts.join(" · ")}
      data-testid="branch-digest-chip"
      className={`inline-flex items-center gap-1 rounded-sw border border-sw-border bg-sw-surface px-1.5 py-0.5 text-xs whitespace-nowrap ${className ?? ""}`.trim()}
    >
      {slices.map((b, idx) => {
        const n = digest[b.key] as number;
        return (
          <span key={b.key} className={`inline-flex items-center gap-0.5 ${b.tone}`}>
            <span aria-hidden>{b.glyph}</span>
            <span className="font-mono text-[10px]">{n}</span>
            {idx < slices.length - 1 ? <span className="text-sw-muted">·</span> : null}
          </span>
        );
      })}
    </span>
  );
}

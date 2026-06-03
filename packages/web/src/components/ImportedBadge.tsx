// ImportedBadge — status-style pill for runs brought in via `fragua import`.
//
// Visual contract: matches `RunStatusBadge` shape (rounded-full, xs font,
// bordered pill). Uses the neutral/muted palette to signal inspect-only
// status without implying any actionable state.

export function ImportedBadge({
  className,
  "data-testid": testId,
}: {
  className?: string;
  "data-testid"?: string;
}): JSX.Element {
  return (
    <span
      data-testid={testId ?? "imported-badge"}
      className={`inline-block shrink-0 rounded-full border border-sw-border bg-sw-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-sw-muted${className ? ` ${className}` : ""}`}
    >
      imported
    </span>
  );
}

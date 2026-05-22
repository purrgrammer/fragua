import type { HTMLAttributes } from "react";
import type { SnapshotChangeStat } from "../lib/api.ts";
import { cn } from "../lib/utils.ts";

export interface ChangeStatProps extends HTMLAttributes<HTMLSpanElement> {
  stat: SnapshotChangeStat;
  insertionsTestId?: string;
  deletionsTestId?: string;
}

/** Canonical change-stat readout: `N changed +I −D`. The single source of
 *  this format — the diff header, the worktree inbox, and anywhere else that
 *  shows a snapshot delta render through here so the wording, ordering, and
 *  accent colors stay identical. Font size is left to the caller (`className`)
 *  so it can sit in a badge or a header line unchanged. */
export function ChangeStat({
  stat,
  className,
  insertionsTestId,
  deletionsTestId,
  ...rest
}: ChangeStatProps): JSX.Element {
  return (
    <span className={cn("font-mono tabular-nums text-sw-muted", className)} {...rest}>
      {stat.filesChanged} changed{" "}
      <span className="text-sw-accent-success" data-testid={insertionsTestId}>
        +{stat.insertions}
      </span>{" "}
      <span className="text-sw-accent-error" data-testid={deletionsTestId}>
        −{stat.deletions}
      </span>
    </span>
  );
}

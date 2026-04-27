// Banner shown above the main outlet when the connected server isn't a
// daemon (i.e. `/health` didn't carry a `daemon` key).
//
// Hairline border, subtle surface, no background shade for hierarchy,
// monospace, sentence case, amber accent for a "something to know about"
// state — not error-red.

import { Zap } from "lucide-react";

export function DaemonBanner(): JSX.Element {
  return (
    <output
      data-testid="daemon-banner"
      className="mb-3 flex items-start gap-2 rounded-sm border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <Zap aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 leading-relaxed">
        <span className="font-medium">Daemon not running.</span>{" "}
        <span>
          Runs will queue until the daemon starts. Start it with <code className="font-mono">swarm daemon start</code>.
        </span>
      </div>
    </output>
  );
}

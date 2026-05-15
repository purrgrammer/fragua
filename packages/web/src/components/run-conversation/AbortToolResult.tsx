// Custom rendering for the `abort` core tool. Slots into <ToolContent>'s
// output area when toolName === "abort" inside RichToolResult. Result
// shape is produced by `packages/workspace/src/abort-tool.ts`.
//
// `abort` is the agent's self-halt signal — the backend turns the call
// into a non-retryable fail outcome and the run halts with
// `reason="aborted_exit"`. A generic ToolOutput dump would bury the one
// thing that matters (the reason), so it earns an error-tone card.

import type { ToolResultMessage } from "@swarm/types";
import { OctagonXIcon } from "lucide-react";
import type { JSX } from "react";

export interface AbortToolParams {
  reason?: string;
}

export interface AbortToolData {
  reason?: string;
}

interface AbortToolResultProps {
  params: AbortToolParams | undefined;
  result: ToolResultMessage | undefined;
}

export function AbortToolResult({ params, result }: AbortToolResultProps): JSX.Element {
  // `params.reason` is what the agent passed; `data.reason` is what the
  // tool echoed back. They agree — prefer the agent's input.
  const data = ((result?.details as { data?: AbortToolData } | undefined)?.data ?? {}) as AbortToolData;
  const reason = params?.reason ?? data.reason ?? "(no reason given)";

  return (
    <div
      className="flex items-start gap-[var(--sw-space-2)] rounded-[var(--sw-radius-default)] border px-[var(--sw-space-3)] py-[var(--sw-space-2)]"
      style={{
        borderColor: "color-mix(in oklch, var(--sw-accent-error) 30%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--sw-accent-error) 7%, transparent)",
      }}
      data-testid="abort-card"
    >
      <OctagonXIcon className="mt-0.5 size-4 shrink-0" style={{ color: "var(--sw-accent-error)" }} />
      <div className="min-w-0 flex-1 space-y-[var(--sw-space-1)]">
        <div
          className="font-medium uppercase tracking-[0.06em] text-[length:var(--sw-text-xs)]"
          style={{ color: "var(--sw-accent-error)" }}
        >
          Run aborted
        </div>
        <p className="whitespace-pre-wrap font-mono text-[length:var(--sw-text-sm)] text-[var(--sw-text)]">{reason}</p>
      </div>
    </div>
  );
}

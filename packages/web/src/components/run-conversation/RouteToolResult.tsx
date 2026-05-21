// Custom rendering for the `route` built-in tool. Slots into <ToolContent>'s
// output area when toolName === "route" inside RichToolResult.
//
// The backend synthesises a per-routing-node `route` tool whose single
// parameter is `name` (enum-constrained to the declared routes). On
// completion, `result.details.data.route` carries the chosen route name.
// A generic ToolOutput dump would just show `"route: <name>"` — surfacing
// the choice as a named card gives operators a clear signal of which path
// the agent selected.

import type { ToolResultMessage } from "@fragua/types";
import { SignpostIcon } from "lucide-react";
import type { JSX } from "react";

export interface RouteToolParams {
  name?: string;
}

export interface RouteToolData {
  route?: string;
}

interface RouteToolResultProps {
  params: RouteToolParams | undefined;
  result: ToolResultMessage | undefined;
}

export function RouteToolResult({ params, result }: RouteToolResultProps): JSX.Element {
  // `data.route` is the canonical echo from the tool's execute(); prefer it
  // over `params.name` so the completed state shows the verified value.
  // When the result is still pending (streaming), fall back to `params.name`.
  const data = ((result?.details as { data?: RouteToolData } | undefined)?.data ?? {}) as RouteToolData;
  const chosen = data.route ?? params?.name ?? "(no route chosen)";

  return (
    <div
      className="flex items-start gap-[var(--sw-space-2)] rounded-[var(--sw-radius-default)] border px-[var(--sw-space-3)] py-[var(--sw-space-2)]"
      style={{
        borderColor: "color-mix(in oklch, var(--sw-accent-thinking) 30%, transparent)",
        backgroundColor: "color-mix(in oklch, var(--sw-accent-thinking) 7%, transparent)",
      }}
      data-testid="route-card"
    >
      <SignpostIcon className="mt-0.5 size-4 shrink-0" style={{ color: "var(--sw-accent-thinking)" }} />
      <div className="min-w-0 flex-1 space-y-[var(--sw-space-1)]">
        <div
          className="font-medium uppercase tracking-[0.06em] text-[length:var(--sw-text-xs)]"
          style={{ color: "var(--sw-accent-thinking)" }}
        >
          Routed to
        </div>
        <p
          className="whitespace-pre-wrap font-mono text-[length:var(--sw-text-sm)] text-[var(--sw-text)]"
          data-testid="route-card-name"
        >
          {chosen}
        </p>
      </div>
    </div>
  );
}

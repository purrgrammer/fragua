// ModelBadge — provider logo + model id, the shared way to show which model a
// node or step ran on. Used in the graph node card and the cost breakdown so
// the model reads identically in both places.

import { cn } from "../../lib/cn.ts";
import { ModelSelectorLogo } from "../ai-elements/model-selector.tsx";

export function ModelBadge({
  provider,
  model,
  className,
}: {
  provider?: string | undefined;
  model: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1", className)}
      title={provider ? `${provider} · ${model}` : model}
    >
      {provider ? <ModelSelectorLogo className="shrink-0" provider={provider} /> : null}
      <code className="truncate text-sw-text">{model}</code>
    </span>
  );
}

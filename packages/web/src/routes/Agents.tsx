// /agents — discovered named sub-agent profiles. Read-only list with
// a rescan button. Click a row to open the detail view (metadata
// header + the prompt body the sub-agent receives verbatim).

import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { AgentsList, useAgentsRescan } from "../components/agents/agents-list.tsx";
import { Button } from "../components/ui/button.tsx";

export function Agents(): JSX.Element {
  const [searchParams] = useSearchParams();
  const projectCwd = searchParams.get("project_cwd") ?? undefined;
  const rescan = useAgentsRescan();

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">Agents</h2>
        <Button variant="outline" size="sm" onClick={rescan} data-testid="agents-rescan" aria-label="Rescan agents">
          <RefreshCw className="size-3.5" />
          Rescan
        </Button>
      </header>
      <AgentsList projectCwd={projectCwd} testIdPrefix="agents" compact />
    </section>
  );
}

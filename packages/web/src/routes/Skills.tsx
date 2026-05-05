// /skills — discovery view across globals + every cwd in run_state.
// Read-only; click a row to open the detail view (metadata header +
// file tree + on-demand file viewer). The Rescan button invalidates
// the `["skills",…]` cache and re-walks the filesystem on the server
// side.
//
// `?project_cwd=<cwd>` scopes the list to globals + that one project,
// matching what a run in that cwd actually sees at codergen time.

import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { SkillsList, useSkillsRescan } from "../components/skills/skills-list.tsx";
import { Button } from "../components/ui/button.tsx";

export function Skills(): JSX.Element {
  const [searchParams] = useSearchParams();
  const projectCwd = searchParams.get("project_cwd") ?? undefined;
  const rescan = useSkillsRescan();

  return (
    <section className="flex w-full min-w-0 flex-col gap-3">
      <header className="flex items-center justify-between">
        <h2 className="font-heading text-base font-semibold">Skills</h2>
        <Button variant="outline" size="sm" onClick={rescan} data-testid="skills-rescan" aria-label="Rescan skills">
          <RefreshCw className="size-3.5" />
          Rescan
        </Button>
      </header>
      <SkillsList projectCwd={projectCwd} testIdPrefix="skills" />
    </section>
  );
}

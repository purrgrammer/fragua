// Project dropdown for /analytics. Sibling to WindowSelector; pinned to
// the same Select shape so the two controls read as one chrome row.
// `null` is the user-facing "All projects" sentinel — translated to/from
// the `__all__` Select value at the boundary so the parent gets a clean
// `string | null` (project_id or unfiltered). The emitted value is the
// project IDENTITY (`project_id`); labels come from the project `name`.

import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";

// Sentinel for the "All projects" choice. Radix Select requires every
// `SelectItem` to have a non-empty `value`; the wrapper translates this
// at the boundary so the parent contract stays `string | null`.
export const ALL_PROJECTS_VALUE = "__all__";

/** Translate a Radix value back to the parent's `string | null`
 *  contract. Exported for unit testing the translation without driving
 *  the Radix portal in happy-dom (which doesn't render the listbox). */
export function projectSelectValueToProjectId(v: string): string | null {
  return v === ALL_PROJECTS_VALUE ? null : v;
}

/** Translate a parent value (project_id) into the Radix-side string. */
export function projectIdToSelectValue(projectId: string | null): string {
  return projectId ?? ALL_PROJECTS_VALUE;
}

export interface ProjectSelectorProps {
  value: string | null;
  onChange: (next: string | null) => void;
}

export function ProjectSelector({ value, onChange }: ProjectSelectorProps): JSX.Element {
  const { data } = useQuery(queries.projects.list());
  const projects = data ?? [];

  return (
    <Select value={projectIdToSelectValue(value)} onValueChange={(v) => onChange(projectSelectValueToProjectId(v))}>
      <SelectTrigger className="w-[12rem]" aria-label="Project filter" data-testid="project-selector">
        <SelectValue placeholder="All projects" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PROJECTS_VALUE} data-testid="project-all">
          All projects
        </SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.projectId} value={p.projectId} data-testid={`project-${p.projectId}`}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

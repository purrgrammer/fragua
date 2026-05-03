// Project (cwd) dropdown for /analytics. Sibling to WindowSelector;
// pinned to the same Select shape so the two controls read as one
// chrome row. `null` is the user-facing "All projects" sentinel —
// translated to/from the `__all__` Select value at the boundary so the
// parent gets a clean `string | null` (cwd or unfiltered).

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
export function projectSelectValueToCwd(v: string): string | null {
  return v === ALL_PROJECTS_VALUE ? null : v;
}

/** Translate a parent value into the Radix-side string. */
export function cwdToProjectSelectValue(cwd: string | null): string {
  return cwd ?? ALL_PROJECTS_VALUE;
}

export interface ProjectSelectorProps {
  value: string | null;
  onChange: (next: string | null) => void;
}

export function ProjectSelector({ value, onChange }: ProjectSelectorProps): JSX.Element {
  const { data } = useQuery(queries.projects.list());
  const projects = data ?? [];

  return (
    <Select value={cwdToProjectSelectValue(value)} onValueChange={(v) => onChange(projectSelectValueToCwd(v))}>
      <SelectTrigger className="w-[12rem]" aria-label="Project filter" data-testid="project-selector">
        <SelectValue placeholder="All projects" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PROJECTS_VALUE} data-testid="project-all">
          All projects
        </SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.cwd} value={p.cwd} data-testid={`project-${p.cwd}`}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

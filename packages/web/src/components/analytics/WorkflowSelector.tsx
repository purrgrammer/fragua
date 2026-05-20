// Workflow dropdown for /analytics. Sibling to ProjectSelector +
// WindowSelector. Identity = `(scope, name[, cwd])`, sha-collapsed —
// every edit of `research.yaml` aggregates into one row. `null` is the
// "All workflows" sentinel (translated to `__all__` at the Radix
// boundary so the parent contract stays a typed union).
//
// Local-workflow visibility:
//   - Project pinned ("swarm") → that project's locals only,
//                                 labelled by name.
//   - All projects             → every local across every project,
//                                 grouped per-project so the user can
//                                 tell apart same-named locals
//                                 (e.g. `research` in `swarm` vs in
//                                 `frontend`). Picking one auto-pins
//                                 the project (the parent observes
//                                 `selection.cwd` on the change).
// Globals always show regardless.

import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo } from "react";
import { queries } from "@/lib/queries";
import type { AnalyticsWorkflowEntry, WorkflowScopeFilter } from "../../lib/api.ts";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";

export const ALL_WORKFLOWS_VALUE = "__all__";

/** Wire identity for one entry. The string form is what the Radix
 *  Select binds to; the parent contract is the structured selection.
 *  `cwd` accompanies local selections so the parent can pin
 *  ProjectSelector when the user picks a local from the All-projects
 *  view; it is `null` for globals (which transcend projects). */
export interface WorkflowSelection {
  scope: WorkflowScopeFilter;
  name: string;
  cwd: string | null;
}

/** `scope:name[:cwd]` — colons are illegal in workflow_name (identifier grammar
 *  disallows them in identifiers), but a cwd can absolutely contain
 *  colons (Windows drive letters, etc.), so we URL-encode it. The
 *  encoding is parsable from the left: first colon ends scope, second
 *  ends name, the rest is cwd (still URL-encoded for safety). */
export function workflowSelectionToValue(sel: WorkflowSelection | null): string {
  if (sel === null) return ALL_WORKFLOWS_VALUE;
  if (sel.cwd === null) return `${sel.scope}:${sel.name}`;
  return `${sel.scope}:${sel.name}:${encodeURIComponent(sel.cwd)}`;
}

export function workflowSelectValueToSelection(v: string): WorkflowSelection | null {
  if (v === ALL_WORKFLOWS_VALUE) return null;
  const firstColon = v.indexOf(":");
  if (firstColon <= 0) return null;
  const scope = v.slice(0, firstColon);
  if (scope !== "global" && scope !== "local") return null;
  const rest = v.slice(firstColon + 1);
  const secondColon = rest.indexOf(":");
  if (secondColon === -1) {
    if (rest.length === 0) return null;
    return { scope, name: rest, cwd: null };
  }
  const name = rest.slice(0, secondColon);
  const cwdRaw = rest.slice(secondColon + 1);
  if (name.length === 0 || cwdRaw.length === 0) return null;
  let cwd: string;
  try {
    cwd = decodeURIComponent(cwdRaw);
  } catch {
    return null;
  }
  return { scope, name, cwd };
}

export interface WorkflowSelectorProps {
  /** `null` → "All workflows". */
  value: WorkflowSelection | null;
  /** Called with a structured selection. For locals chosen while the
   *  page-level `cwd` is null, `next.cwd` carries the project root
   *  the user picked — the parent should pin its ProjectSelector to
   *  that cwd alongside the workflow. */
  onChange: (next: WorkflowSelection | null) => void;
  /** Currently-pinned project (`ProjectSelector` value). Drives the
   *  local-entry layout: per-name when pinned, per-`(cwd, name)` when
   *  null. */
  cwd: string | null;
}

/** `basename` for cwd labels — last path segment, fall back to the
 *  whole string for unusual paths (Windows drives, no separators). */
function projectLabel(cwd: string): string {
  const idx = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
  if (idx === -1 || idx === cwd.length - 1) return cwd;
  return cwd.slice(idx + 1);
}

export function WorkflowSelector({ value, onChange, cwd }: WorkflowSelectorProps): JSX.Element {
  const { data } = useQuery(queries.analytics.workflows(cwd));
  const workflows = data ?? [];

  // Globals always show. Locals split two ways:
  //  - Pinned cwd: flat list of that project's locals.
  //  - All projects: bucketed by cwd → each project gets a sub-group
  //    so same-named locals across projects stay distinguishable.
  const { globals, localsFlat, localsByProject } = useMemo(() => {
    const g: AnalyticsWorkflowEntry[] = [];
    const flat: AnalyticsWorkflowEntry[] = [];
    const byProject = new Map<string, AnalyticsWorkflowEntry[]>();
    for (const w of workflows) {
      if (w.scope === "global") {
        g.push(w);
        continue;
      }
      if (w.scope !== "local" || w.cwd === null) continue;
      if (cwd !== null) {
        if (w.cwd === cwd) flat.push(w);
      } else {
        const bucket = byProject.get(w.cwd);
        if (bucket) bucket.push(w);
        else byProject.set(w.cwd, [w]);
      }
    }
    return { globals: g, localsFlat: flat, localsByProject: byProject };
  }, [workflows, cwd]);

  const radixValue = workflowSelectionToValue(value);

  return (
    <Select value={radixValue} onValueChange={(v) => onChange(workflowSelectValueToSelection(v))}>
      <SelectTrigger className="w-[14rem]" aria-label="Workflow filter" data-testid="workflow-selector">
        <SelectValue placeholder="All workflows" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_WORKFLOWS_VALUE} data-testid="workflow-all">
          All workflows
        </SelectItem>
        {globals.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Global</SelectLabel>
              {globals.map((w) => {
                const v = workflowSelectionToValue({ scope: "global", name: w.name, cwd: null });
                return (
                  <SelectItem key={v} value={v} data-testid={`workflow-${v}`}>
                    {w.name}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          </>
        )}
        {cwd !== null && localsFlat.length > 0 && (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Local</SelectLabel>
              {localsFlat.map((w) => {
                // w.cwd === cwd by construction — preserve it on the
                // selection so the parent's effective filter encodes
                // both the workflow lineage and the project that
                // anchors it.
                const v = workflowSelectionToValue({ scope: "local", name: w.name, cwd: w.cwd });
                return (
                  <SelectItem key={v} value={v} data-testid={`workflow-${v}`}>
                    {w.name}
                  </SelectItem>
                );
              })}
            </SelectGroup>
          </>
        )}
        {cwd === null &&
          [...localsByProject.entries()].map(([projectCwd, items]) => (
            <Fragment key={`local-${projectCwd}`}>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Local · {projectLabel(projectCwd)}</SelectLabel>
                {items.map((w) => {
                  const v = workflowSelectionToValue({ scope: "local", name: w.name, cwd: projectCwd });
                  return (
                    <SelectItem key={v} value={v} data-testid={`workflow-${v}`}>
                      {w.name}
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </Fragment>
          ))}
      </SelectContent>
    </Select>
  );
}

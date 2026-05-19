// /skills/:locId — read-only skill detail. Three sections:
//   1. Metadata header (name, description, scope, source, sha, …).
//   2. File tree under skill_dir (left pane).
//   3. File viewer (right pane). SKILL.md auto-selects on mount.
//
// Both tree and per-file content are fetched via the queries.skills
// factories — tanstack-query holds them client-side with a long
// staleTime so navigating back to a previously-opened file is
// instant.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileTree } from "../components/ai-elements/file-tree.tsx";
import { FileViewer } from "../components/skills/file-viewer.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { SkillSummary } from "../lib/api.ts";
import { buildTree, TreeNodeView } from "../lib/file-tree.tsx";
import { queries } from "../lib/queries.ts";

export function SkillDetail(): JSX.Element {
  const { locId: rawLocId } = useParams<{ locId: string }>();
  const locId = rawLocId ?? "";
  const detail = useQuery({ ...queries.skills.detail(locId), enabled: locId.length > 0 });
  const tree = useQuery({ ...queries.skills.tree(locId), enabled: locId.length > 0 });

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Auto-select SKILL.md as soon as the tree resolves and contains it.
  // The user can click another file to swap; we don't override their
  // explicit selection on subsequent re-renders.
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected) return;
    const entries = tree.data?.tree;
    if (!entries) return;
    const skillMd = entries.find((e) => e.path === "SKILL.md");
    if (skillMd) {
      setSelectedPath("SKILL.md");
      setAutoSelected(true);
    }
  }, [tree.data, autoSelected]);

  const treeRoot = useMemo(() => (tree.data ? buildTree(tree.data.tree) : null), [tree.data]);

  if (detail.isPending) {
    return (
      <p className="text-sm text-sw-muted" data-testid="skill-detail-loading">
        Loading…
      </p>
    );
  }
  if (detail.isError) {
    return (
      <EmptyState
        data-testid="skill-detail-error"
        title="Couldn't load skill"
        description="The server didn't respond as expected. Check the console for details, or retry shortly."
      />
    );
  }
  const skill = detail.data.skill;

  return (
    <section className="flex w-full min-w-0 flex-col gap-4" data-testid="skill-detail">
      <Link
        to="/skills"
        className="text-xs text-sw-muted hover:text-sw-text hover:underline"
        data-testid="skill-detail-back"
      >
        ← all skills
      </Link>
      <Header skill={skill} />
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr] gap-3 rounded-md border border-sw-border bg-sw-surface">
        <aside className="min-h-0 overflow-auto border-r border-sw-border" data-testid="skill-detail-tree-pane">
          {tree.isPending && <p className="p-3 text-xs text-sw-muted">Loading tree…</p>}
          {tree.isError && <p className="p-3 text-xs text-sw-accent-error">Couldn't load tree.</p>}
          {treeRoot && (
            <FileTree selectedPath={selectedPath ?? undefined} onSelect={setSelectedPath}>
              {treeRoot.children.map((child) => (
                <TreeNodeView key={child.path} node={child} />
              ))}
            </FileTree>
          )}
        </aside>
        <div className="min-h-0 overflow-auto" data-testid="skill-detail-viewer-pane">
          <FileViewer locId={locId} path={selectedPath} />
        </div>
      </div>
    </section>
  );
}

function Header({ skill }: { skill: SkillSummary }): JSX.Element {
  const fields = useMemo(
    () =>
      (
        [
          ["scope", skill.scope],
          ["source", skill.source_dir],
          ["project", skill.project_cwd ?? "—"],
          ["bytes", String(skill.bytes)],
          ["sha256", shortSha(skill.sha256)],
          ["version", skill.version ?? "—"],
          ["license", skill.license ?? "—"],
          ["compatibility", skill.compatibility ?? "—"],
          ["allowed_tools", skill.allowed_tools?.length ? skill.allowed_tools.join(", ") : "—"],
        ] as const
      ).filter(([, v]) => v !== "" && v !== undefined),
    [skill],
  );

  return (
    <header className="flex flex-col gap-2 rounded-md border border-sw-border bg-sw-surface p-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-heading text-lg font-semibold" data-testid="skill-detail-name">
          {skill.name}
        </h2>
        {skill.disabled_reason && (
          <span
            className="rounded bg-sw-surface-2 px-2 py-0.5 font-mono text-xs text-sw-muted"
            data-testid="skill-detail-disabled"
            title={skill.disabled_reason}
          >
            disabled: {skill.disabled_reason}
          </span>
        )}
      </div>
      <p className="text-sm text-sw-text" data-testid="skill-detail-description">
        {skill.description}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs text-sw-muted lg:grid-cols-3">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-2 truncate">
            <dt className="shrink-0">{k}:</dt>
            <dd className="truncate" title={String(v)}>
              {String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

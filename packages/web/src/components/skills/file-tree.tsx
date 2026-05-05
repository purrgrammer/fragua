// Flat indented file tree for the SkillDetail view. The server returns
// a pre-order traversal under skill_dir, so depth = path-segment count
// suffices for rendering. Click-to-select drives the viewer pane on
// the right.

import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import type { SkillTreeEntry } from "../../lib/api.ts";

export interface FileTreeProps {
  entries: readonly SkillTreeEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

export function FileTree({ entries, selectedPath, onSelect }: FileTreeProps): JSX.Element {
  // Track which directory paths are expanded. Default-open the first
  // level and any directory that's an ancestor of the selected path
  // (so the selection is visible without manual hunting).
  const initialExpanded = useMemo(() => {
    const open = new Set<string>();
    for (const e of entries) {
      if (e.type === "dir" && depthOf(e.path) === 0) open.add(e.path);
    }
    if (selectedPath) {
      for (const ancestor of ancestorsOf(selectedPath)) open.add(ancestor);
    }
    return open;
  }, [entries, selectedPath]);

  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const visible = useMemo(() => {
    return entries.filter((e) => {
      const parents = ancestorsOf(e.path);
      // An entry is visible iff every parent dir is in the expanded set.
      return parents.every((p) => expanded.has(p));
    });
  }, [entries, expanded]);

  // Plain `<ul>`/`<li>` semantics: the buttons inside provide keyboard
  // focus + activation, so adding `role="tree"`/`role="treeitem"` would
  // duplicate ARIA without buying screen-reader behaviour we need.
  return (
    <ul className="font-mono text-xs" data-testid="file-tree">
      {visible.map((e) => {
        const depth = depthOf(e.path);
        const isSelected = selectedPath === e.path;
        const isExpanded = expanded.has(e.path);
        return (
          <li key={e.path}>
            <button
              type="button"
              onClick={() => {
                if (e.type === "dir") toggle(e.path);
                else onSelect(e.path);
              }}
              aria-pressed={isSelected ? "true" : undefined}
              className={`flex w-full items-center gap-1 px-2 py-1 text-left transition-colors duration-[var(--sw-duration-hover)] hover:bg-sw-hover ${
                isSelected ? "bg-sw-selected text-sw-text" : "text-sw-muted hover:text-sw-text"
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              data-testid={`file-tree-${e.type}-${e.path}`}
              data-selected={isSelected ? "true" : undefined}
            >
              {e.type === "dir" ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="size-3 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0" />
                  )}
                  {isExpanded ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                </>
              ) : (
                <>
                  <span className="size-3 shrink-0" />
                  <File className="size-3.5 shrink-0" />
                </>
              )}
              <span className="truncate">{leafOf(e.path)}</span>
              {e.type === "file" && <span className="ml-auto pl-2 text-sw-muted/70">{formatBytes(e.size)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function depthOf(path: string): number {
  if (path === "") return 0;
  return path.split("/").length - 1;
}

function leafOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Folding logic + view helper for the flat `{path,type}[]` shape both
// `GET /projects/:id/tree` and `GET /runs/:id/tree` return. The
// FileTree primitive (`components/ai-elements/file-tree.tsx`) wants a
// nested folder/file shape; this module owns the unfold + sort and the
// recursive renderer so ProjectDetail and RunDetail share one
// implementation. Best-effort extension → shiki language mapping lives
// here too — same heuristic both routes need for the CodeBlock viewer.

import type { BundledLanguage } from "shiki";
import { FileTreeFile, FileTreeFolder } from "../components/ai-elements/file-tree.tsx";

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

/** Fold the flat `{path,type}[]` the server returns into the nested
 *  shape `<FileTree>` consumes. Folders appear in the input only when
 *  they contain at least one file (the server includes every ancestor),
 *  so we don't need to invent empty directories here. */
export function buildTree(entries: ReadonlyArray<{ path: string; type: "file" | "dir" }>): TreeNode {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirByPath = new Map<string, TreeNode>();
  dirByPath.set("", root);

  const ensureDir = (path: string): TreeNode => {
    const cached = dirByPath.get(path);
    if (cached) return cached;
    const segs = path.split("/");
    const name = segs[segs.length - 1] ?? path;
    const parentPath = segs.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name, path, type: "dir", children: [] };
    parent.children.push(node);
    dirByPath.set(path, node);
    return node;
  };

  for (const e of entries) {
    if (e.type === "dir") ensureDir(e.path);
  }
  for (const e of entries) {
    if (e.type !== "file") continue;
    const segs = e.path.split("/");
    const name = segs[segs.length - 1] ?? e.path;
    const parentPath = segs.slice(0, -1).join("/");
    const parent = ensureDir(parentPath);
    parent.children.push({ name, path: e.path, type: "file", children: [] });
  }

  // Folders before files, then alphabetical within each group.
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    for (const c of n.children) if (c.type === "dir") sortRec(c);
  };
  sortRec(root);
  return root;
}

export function TreeNodeView({ node }: { node: TreeNode }): JSX.Element {
  if (node.type === "file") {
    return <FileTreeFile path={node.path} name={node.name} />;
  }
  return (
    <FileTreeFolder path={node.path} name={node.name}>
      {node.children.map((child) => (
        <TreeNodeView key={child.path} node={child} />
      ))}
    </FileTreeFolder>
  );
}

/** Best-effort extension → shiki BundledLanguage. Anything unknown
 *  falls back to `bash` so the viewer renders without trying to load
 *  a non-existent grammar. Extension list mirrors what ProjectDetail
 *  used to inline. */
export function extToLang(path: string): BundledLanguage {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "shell";
  const ext = path.slice(dot + 1).toLowerCase();
  const map: Partial<Record<string, BundledLanguage>> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    mdx: "mdx",
    html: "html",
    css: "css",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    bash: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    sql: "sql",
    toml: "toml",
  };
  return map[ext] ?? "bash";
}

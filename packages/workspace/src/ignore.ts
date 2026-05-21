// Default ignore set for grep + find. Codified once so the two tools
// can't drift. The patterns are intentionally narrow and string-based
// — no minimatch dependency, no .gitignore parsing. Anything fancier
// goes through `bash` with a hand-rolled `find`.
//
// Directory patterns end with `/`: matched if any path segment equals
// the pattern (without the slash). File patterns are basename globs
// limited to a leading `*.` extension match.

export const DEFAULT_IGNORE_GLOBS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".fragua/",
  ".next/",
  "coverage/",
  "*.pyc",
  "*.min.js",
] as const;

const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(
  DEFAULT_IGNORE_GLOBS.filter((g) => g.endsWith("/")).map((g) => g.slice(0, -1)),
);

const IGNORED_SUFFIXES: readonly string[] = DEFAULT_IGNORE_GLOBS.filter((g) => g.startsWith("*.")).map((g) =>
  g.slice(1),
);

/** Return true if `relPath` is covered by the default ignore set.
 * Accepts forward-slash or backslash separators. Empty / "." is never
 * ignored (the search root). */
export function shouldIgnore(relPath: string): boolean {
  if (!relPath || relPath === ".") return false;
  const normalized = relPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  for (const seg of segments) {
    if (IGNORED_SEGMENTS.has(seg)) return true;
  }
  const basename = segments[segments.length - 1] ?? "";
  for (const suffix of IGNORED_SUFFIXES) {
    if (basename.endsWith(suffix)) return true;
  }
  return false;
}

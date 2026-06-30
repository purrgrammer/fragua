// Shared release plumbing for `fragua upgrade` and the harness update notice.
// Holds the one definition of the release repo, the dev/standalone-binary
// detection, and the latest-tag resolution (tokenless GitHub API GET, no `gh`)
// so the two consumers can't disagree about where releases come from or how
// versions are read. The repo is PUBLIC, so release metadata and assets are
// reachable over plain HTTPS with no auth.

export const RELEASE_REPO = "purrgrammer/fragua";

/** The public GitHub API endpoint for a repo's latest release. One source of
 * truth: built from `RELEASE_REPO`. */
export function latestReleaseApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

// `bun build --compile` serves the entry module from an embedded virtual
// filesystem; in dev it's a real `.ts` on disk.
export function isStandaloneBinary(): boolean {
  const u = import.meta.url;
  return u.includes("/$bunfs/") || u.includes("/~BUN/") || u.includes("\\~BUN\\") || u.startsWith("B:");
}

/** A `bun run` checkout (not a compiled single binary) can't replace itself —
 * there's no standalone executable to swap, and an update notice would be
 * noise. Treat the dev fallback version or a non-standalone entry module as
 * dev. */
export function isDevBuild(version: string, standalone: boolean): boolean {
  return !standalone || version === "0.0.0-dev";
}

/** Resolve the latest published release tag via a tokenless GitHub API GET, or
 * null on any failure — non-200, network error, timeout, or parse failure.
 * Best-effort + timeout-bounded so a slow network can neither block the caller
 * nor hang: the harness update notice degrades silently. */
export async function resolveLatestTag(opts: { timeoutMs?: number } = {}): Promise<string | null> {
  try {
    const res = await fetch(latestReleaseApiUrl(RELEASE_REPO), {
      headers: { "User-Agent": "fragua", Accept: "application/vnd.github+json" },
      ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
    return tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

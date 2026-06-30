// Shared release plumbing for `fragua upgrade` and the harness update notice.
// Holds the one definition of the release repo, the dev/standalone-binary
// detection, and the `gh`-backed latest-tag resolution so the two consumers
// can't disagree about where releases come from or how versions are read.

import { spawn } from "node:child_process";

export const RELEASE_REPO = "purrgrammer/fragua";

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

/** Resolve the latest published release tag via `gh`, or null on any failure
 * — non-zero exit, unauthenticated `gh`, missing binary, or timeout. Async +
 * timeout-bounded so a slow network can neither block the caller nor leave a
 * lingering child. */
export function resolveLatestTag(opts: { timeoutMs?: number } = {}): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolvePromise(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", ["release", "view", "--repo", RELEASE_REPO, "--json", "tagName", "-q", ".tagName"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      done(null);
      return;
    }

    let out = "";
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill("SIGKILL");
            done(null);
          }, opts.timeoutMs)
        : undefined;

    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", () => {
      if (timer !== undefined) clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (code !== 0) {
        done(null);
        return;
      }
      const tag = out.trim();
      done(tag.length > 0 ? tag : null);
    });
  });
}

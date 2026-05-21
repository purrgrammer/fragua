// Locate + (re)build the @fragua/web bundle on demand.
//
// The harness ships with a built bundle at `packages/web/dist/`, but the
// devloop edits live in `packages/web/src/`. This helper detects when src
// is newer than dist (or dist is missing entirely) and runs `vite build`
// before the HTTP server mounts the static handler. No-op for production
// installs where the source tree is stripped — we trust whatever dist
// shipped. `FRAGUA_NO_WEB_BUILD=1` skips the check even when source is
// present (CI smoke tests where the bundle is built once upstream).
//
// Test-friendliness: this lives outside `startServer` so the existing
// startup-path tests don't pay a 5s vite build per spec. CLI commands
// (`fragua harness`, `fragua serve`) call it explicitly and pass the
// resolved distDir into `startServer`.

import { spawn } from "node:child_process";
import { type Dirent, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

export interface EnsureWebBundleOptions {
  /** Absolute path to `packages/web/`. Defaults to a walk-up from this
   * file's location (`packages/cli/src/` → `../../web`). Tests inject
   * their own to exercise the staleness logic without touching the real
   * bundle. */
  webPackageDir?: string;
  /** Print one-line status messages via console.log. Default true. */
  verbose?: boolean;
  /** Override `bun run build`. Tests pass a no-op so the helper's
   * decision logic is exercised without spawning vite. */
  runBuild?: (cwd: string) => Promise<boolean>;
}

export type EnsureWebBundleReason =
  | "no-source"
  | "skipped-env"
  | "fresh"
  | "rebuilt-stale"
  | "built-missing"
  | "build-failed";

export interface EnsureWebBundleResult {
  /** Path to the dist directory if usable; undefined when no build was
   * possible (no source AND no pre-existing dist, or build failed with
   * no fallback). */
  distDir: string | undefined;
  /** Whether `vite build` actually ran. */
  built: boolean;
  reason: EnsureWebBundleReason;
  /** Wall-clock duration when `built === true`. */
  durationMs?: number;
}

/** Top-level files outside `src/` that vite reads as build inputs. Mtime
 * bumps on any of them invalidate the dist. */
const ROOT_INPUTS = ["vite.config.ts", "index.html", "package.json", "tailwind.config.ts", "postcss.config.js"];

export async function ensureWebBundle(opts: EnsureWebBundleOptions = {}): Promise<EnsureWebBundleResult> {
  const verbose = opts.verbose ?? true;
  const webPackageDir = opts.webPackageDir ?? defaultWebPackageDir();
  const distDir = join(webPackageDir, "dist");
  const distIndex = join(distDir, "index.html");
  const srcDir = join(webPackageDir, "src");
  const distExists = existsSync(distIndex);

  if (!existsSync(srcDir)) {
    return { distDir: distExists ? distDir : undefined, built: false, reason: "no-source" };
  }
  if (process.env["FRAGUA_NO_WEB_BUILD"] === "1") {
    return { distDir: distExists ? distDir : undefined, built: false, reason: "skipped-env" };
  }

  const distMtime = distExists ? statSync(distIndex).mtimeMs : 0;
  const srcMtime = await maxMtime(srcDir);
  const rootMtime = ROOT_INPUTS.map((f) => join(webPackageDir, f))
    .filter(existsSync)
    .reduce((acc, f) => Math.max(acc, statSync(f).mtimeMs), 0);
  const inputMtime = Math.max(srcMtime, rootMtime);

  if (distMtime > 0 && distMtime >= inputMtime) {
    return { distDir, built: false, reason: "fresh" };
  }

  const reason: EnsureWebBundleReason = distMtime === 0 ? "built-missing" : "rebuilt-stale";
  if (verbose) {
    const msg = reason === "built-missing" ? "web bundle missing — building…" : "web bundle stale — rebuilding…";
    console.log(chalk.dim(`  ${msg}`));
  }
  const t0 = performance.now();
  const ok = await (opts.runBuild ?? runViteBuild)(webPackageDir);
  const durationMs = performance.now() - t0;
  if (!ok) {
    if (verbose) {
      console.log(
        chalk.yellow(
          `  web build failed after ${(durationMs / 1000).toFixed(1)}s — ${distExists ? "serving stale dist" : "API-only mode"}`,
        ),
      );
    }
    return {
      distDir: distExists ? distDir : undefined,
      built: false,
      reason: "build-failed",
      durationMs,
    };
  }
  if (verbose) {
    console.log(chalk.dim(`  web bundle ready (${(durationMs / 1000).toFixed(1)}s)`));
  }
  return { distDir, built: true, reason, durationMs };
}

function defaultWebPackageDir(): string {
  // packages/cli/src/web-build.ts → packages/web
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../../web");
}

async function maxMtime(dir: string): Promise<number> {
  let max = 0;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true, encoding: "utf8" })) as Dirent[];
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await maxMtime(full);
      if (inner > max) max = inner;
      continue;
    }
    try {
      const m = statSync(full).mtimeMs;
      if (m > max) max = m;
    } catch {
      // unreadable file — skip
    }
  }
  return max;
}

function runViteBuild(cwd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("bun", ["run", "build"], {
      cwd,
      // stdout suppressed (vite's success log is noisy); stderr inherited
      // so build failures surface to the operator.
      stdio: ["ignore", "ignore", "inherit"],
      env: process.env,
    });
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}

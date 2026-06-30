// `fragua upgrade` — self-update the installed fragua binary from GitHub
// Releases. Mirrors `.github/actions/setup-fragua` (same target table, same
// `gh release` download, same fail-closed SHA256SUMS verification) but
// installs the FULL binary (web UI embedded — `harness`/`serve`) and replaces
// the currently-running executable in place.
//
// All network + auth go through the `gh` CLI so private-repo access comes for
// free (the team already installs via `gh`). The pure parts — target mapping,
// asset naming, checksum lookup, tag comparison, and the upgrade decision —
// are factored out and unit-tested; only the `gh` calls and the rename are
// thin and untested.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.ts";
import { isDevBuild, isStandaloneBinary, RELEASE_REPO, resolveLatestTag } from "../release.ts";
import { FRAGUA_VERSION } from "../version.ts";

// Dev/standalone detection is shared with the harness update notice.
export { isDevBuild } from "../release.ts";

// process.platform/process.arch → release target, matching setup-fragua's
// case table. Any pair not here has no published binary.
const TARGET_TABLE: Record<string, string> = {
  "linux/x64": "bun-linux-x64",
  "linux/arm64": "bun-linux-arm64",
  "darwin/arm64": "bun-darwin-arm64",
  "darwin/x64": "bun-darwin-x64",
};

/** Resolve the release target string for a host platform/arch pair. Throws
 * `no published binary for <platform>/<arch>` for anything unsupported. */
export function hostTarget(platform: string, arch: string): string {
  const target = TARGET_TABLE[`${platform}/${arch}`];
  if (target === undefined) throw new Error(`no published binary for ${platform}/${arch}`);
  return target;
}

/** Full asset name for a target — the FULL (web-UI-embedded) binary, which is
 * what an interactive operator (`harness`/`serve`) wants. */
export function assetName(target: string): string {
  return `fragua-${target}`;
}

/** Look up an asset's hex digest in a SHA256SUMS blob. Each line is
 * `<64-hex>  <filename>` (sha256sum's two-space form; a `*` binary marker is
 * tolerated). Returns the lowercased digest, or null when the asset is absent
 * — the caller treats absence as a fail-closed verification failure. */
export function lookupDigest(sums: string, asset: string): string | null {
  for (const raw of sums.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m == null) continue;
    const [, digest, name] = m;
    if (digest !== undefined && name === asset) return digest.toLowerCase();
  }
  return null;
}

/** Drop a single leading `v` and surrounding whitespace so `v0.9.0` and
 * `0.9.0` compare equal. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^v/, "");
}

function versionParts(v: string): number[] {
  const core = normalizeTag(v).split("-")[0] ?? "";
  return core.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/** Compare two version strings on their numeric major.minor.patch, tolerant of
 * a leading `v` and any `-prerelease` suffix. Returns -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type UpgradeDecision = { action: "noop" } | { action: "blocked-by-pin"; pin: string } | { action: "upgrade" };

/** Decide what `fragua upgrade` should do given the current version, the
 * resolved target tag, an optional config pin, and an optional explicit
 * `--to`. A pin freezes upgrades unless `--to` is passed; otherwise we no-op
 * when already on the target (or newer) and upgrade when behind. */
export function decideAction(args: {
  current: string;
  resolved: string;
  pin: string | undefined;
  to: string | undefined;
}): UpgradeDecision {
  if (args.pin !== undefined && args.to === undefined) {
    return { action: "blocked-by-pin", pin: args.pin };
  }
  if (compareVersions(args.current, args.resolved) >= 0) {
    return { action: "noop" };
  }
  return { action: "upgrade" };
}

function ghAvailable(): boolean {
  return spawnSync("gh", ["--version"], { encoding: "utf8" }).status === 0;
}

function ghAuthenticated(): boolean {
  return spawnSync("gh", ["auth", "status"], { encoding: "utf8" }).status === 0;
}

function ghDownload(tag: string, asset: string, dir: string): boolean {
  const r = spawnSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      RELEASE_REPO,
      "--pattern",
      asset,
      "--pattern",
      "SHA256SUMS",
      "--dir",
      dir,
      "--clobber",
    ],
    { stdio: "inherit" },
  );
  return r.status === 0;
}

export interface UpgradeOptions {
  /** Explicit release tag to install (e.g. `0.9.0` or `v0.9.0`). Omitted ⇒
   * resolve the latest published tag. */
  to?: string;
}

export async function upgradeCommand(opts: UpgradeOptions): Promise<number> {
  const current = FRAGUA_VERSION;

  if (isDevBuild(current, isStandaloneBinary())) {
    console.log("upgrade only applies to an installed binary");
    return 0;
  }

  if (!ghAvailable()) {
    console.error(chalk.red("fragua upgrade: GitHub CLI (`gh`) is not installed"));
    console.error(chalk.dim("  install gh (https://cli.github.com), then run `gh auth login`"));
    return 1;
  }
  if (!ghAuthenticated()) {
    console.error(chalk.red("fragua upgrade: `gh` is not authenticated"));
    console.error(chalk.dim("  run `gh auth login` to reach the release repo"));
    return 1;
  }

  const config = await loadConfig(process.cwd());
  const pin = typeof config.version === "string" ? config.version : undefined;

  // Pin gate first — a frozen install makes no network calls.
  if (pin !== undefined && opts.to === undefined) {
    console.error(chalk.yellow(`fragua upgrade: pinned to ${pin} in ~/.fragua/config.yaml`));
    console.error(chalk.dim("  pass --to <version> to override the pin"));
    return 1;
  }

  const resolvedTag = opts.to ?? (await resolveLatestTag());
  if (resolvedTag == null || resolvedTag.length === 0) {
    console.error(chalk.red("fragua upgrade: could not resolve the latest release tag via `gh`"));
    return 1;
  }

  const decision = decideAction({ current, resolved: resolvedTag, pin, to: opts.to });
  if (decision.action === "noop") {
    console.log(`fragua ${current} is already up to date (target ${normalizeTag(resolvedTag)})`);
    return 0;
  }

  let target: string;
  try {
    target = hostTarget(process.platform, process.arch);
  } catch (e) {
    console.error(chalk.red(`fragua upgrade: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  const asset = assetName(target);

  const dir = mkdtempSync(join(tmpdir(), "fragua-upgrade-"));
  console.log(chalk.dim(`downloading ${asset} (${resolvedTag})…`));
  if (!ghDownload(resolvedTag, asset, dir)) {
    console.error(chalk.red(`fragua upgrade: failed to download ${asset} for ${resolvedTag}`));
    return 1;
  }

  // Fail closed: a missing checksum entry OR a digest mismatch aborts before
  // any replacement, exactly like setup-fragua.
  let sums: string;
  let bytes: Buffer;
  try {
    sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    bytes = readFileSync(join(dir, asset));
  } catch (e) {
    console.error(chalk.red(`fragua upgrade: download incomplete: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }
  const expected = lookupDigest(sums, asset);
  if (expected == null) {
    console.error(chalk.red(`fragua upgrade: no checksum entry for ${asset} in SHA256SUMS`));
    return 1;
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(chalk.red(`fragua upgrade: SHA256 mismatch for ${asset} — binary may have been tampered with`));
    return 1;
  }

  // Atomic in-place replace: write to a temp file in the SAME directory as the
  // real executable, chmod, then rename over the running binary.
  const self = realpathSync(process.execPath);
  const staging = join(dirname(self), `.fragua-upgrade-${process.pid}.tmp`);
  try {
    writeFileSync(staging, bytes);
    chmodSync(staging, 0o755);
    renameSync(staging, self);
  } catch (e) {
    console.error(
      chalk.red(`fragua upgrade: failed to replace ${self}: ${e instanceof Error ? e.message : String(e)}`),
    );
    return 1;
  }

  console.log(chalk.green(`fragua ${current} -> ${normalizeTag(resolvedTag)}`));
  return 0;
}

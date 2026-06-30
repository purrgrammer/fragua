// Non-blocking "new version available" notice for `fragua harness`.
//
// Seam: the whole "should we notify, and with what?" decision is a pure
// function of {current version, latest tag, config, cache freshness, now}.
// The network fetch (tokenless GitHub API GET) and the cache file I/O are thin
// wrappers around it. Everything is best-effort — any error or timeout
// silently yields no notice and never delays harness startup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { compareVersions, normalizeTag } from "./commands/upgrade.ts";
import { loadConfig } from "./config.ts";
import { isDevBuild, isStandaloneBinary, resolveLatestTag } from "./release.ts";
import { FRAGUA_VERSION } from "./version.ts";

/** Hit the network at most ~4×/day. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** Short cap so a slow network can't stall the check. */
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 3_000;

const CACHE_FILE = "update-check.json";

export interface UpdateCheckCache {
  /** Epoch ms of the last successful network resolution. */
  checkedAt: number;
  /** The latest published tag observed at `checkedAt`. */
  latestTag: string;
}

/** Pure: is a cached entry still within TTL relative to `now`? Absent or
 * future-dated entries are stale. */
export function isCacheFresh(cache: UpdateCheckCache | undefined, now: number, ttlMs = UPDATE_CHECK_TTL_MS): boolean {
  if (cache === undefined) return false;
  if (!Number.isFinite(cache.checkedAt)) return false;
  const age = now - cache.checkedAt;
  return age >= 0 && age < ttlMs;
}

/** Pure: should the harness perform an update check at all? Skip in dev (no
 * installed binary to upgrade), when disabled in config, or when a version
 * pin has frozen the install (a notice would just be noise). */
export function shouldCheckForUpdates(args: {
  checkForUpdates: boolean | undefined;
  pin: string | undefined;
  isDev: boolean;
}): boolean {
  if (args.isDev) return false;
  if (args.checkForUpdates === false) return false;
  if (args.pin !== undefined) return false;
  return true;
}

/** Pure: the single notice line to print, or undefined when none is
 * warranted. Folds the skip gates (`shouldCheckForUpdates`) and the
 * newer-than comparison into one decision over {current, latestTag, config}. */
export function decideUpdateNotice(args: {
  current: string;
  latestTag: string | undefined;
  checkForUpdates: boolean | undefined;
  pin: string | undefined;
  isDev: boolean;
}): string | undefined {
  if (!shouldCheckForUpdates(args)) return undefined;
  const { latestTag, current } = args;
  if (latestTag === undefined || latestTag.trim().length === 0) return undefined;
  if (compareVersions(current, latestTag) >= 0) return undefined;
  return `fragua ${normalizeTag(latestTag)} available (you're on ${normalizeTag(current)}) · run \`fragua upgrade\``;
}

function cachePath(home: string): string {
  return join(home, ".fragua", CACHE_FILE);
}

function readCache(home: string): UpdateCheckCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(home), "utf8")) as Partial<UpdateCheckCache>;
    if (typeof parsed.checkedAt === "number" && typeof parsed.latestTag === "string" && parsed.latestTag.length > 0) {
      return { checkedAt: parsed.checkedAt, latestTag: parsed.latestTag };
    }
  } catch {
    // Absent or malformed cache → treat as no cache.
  }
  return undefined;
}

function writeCache(home: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(join(home, ".fragua"), { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify(cache));
  } catch {
    // Best-effort — a write failure just means we re-check next startup.
  }
}

/** Run the check and print the notice. Thin I/O around the pure decision:
 * load config, gate, use a fresh cached tag or fetch + re-cache, then emit at
 * most one dim line. Resolves without throwing on any failure. */
export async function runUpdateNotice(opts: { homeDir?: string; cwd?: string; now?: number } = {}): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const current = FRAGUA_VERSION;
  const isDev = isDevBuild(current, isStandaloneBinary());

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(cwd, { homeDir: home });
  } catch {
    return;
  }
  const pin = typeof config.version === "string" ? config.version : undefined;
  const checkForUpdates = config["check_for_updates"];

  if (!shouldCheckForUpdates({ checkForUpdates, pin, isDev })) return;

  const now = opts.now ?? Date.now();
  const cache = readCache(home);
  let latestTag = cache?.latestTag;
  if (!isCacheFresh(cache, now)) {
    const fetched = await resolveLatestTag({ timeoutMs: UPDATE_CHECK_FETCH_TIMEOUT_MS });
    if (fetched != null) {
      latestTag = fetched;
      writeCache(home, { checkedAt: now, latestTag: fetched });
    }
  }

  const message = decideUpdateNotice({ current, latestTag, checkForUpdates, pin, isDev });
  if (message !== undefined) console.log(chalk.dim(message));
}

/** Fire-and-forget entry point for harness startup. Never awaited, never
 * throws — the harness comes fully up regardless of the check's outcome. */
export function startUpdateNotice(opts: { homeDir?: string; cwd?: string } = {}): void {
  void runUpdateNotice(opts).catch(() => {});
}

#!/usr/bin/env bun
// Propagate the root `package.json` version into every `packages/*/package.json`.
//
// Why a script and not git-grep manual edits: every release needs to bump
// nine workspace packages in lockstep with the root. Forgetting one drifts
// silently — and the `@fragua/cli` version reported by `fragua --version`
// reads the root `package.json` (see packages/cli/src/version.ts), so the
// drift was invisible until someone published with mismatched manifests.
//
// Wire into the release flow: run before tagging / building the binary.
// CI's release.yml already calls `bun run build:bin --version "$TAG"`;
// a tiny `bun run sync-version` step before that closes the loop.
//
// Usage:
//   bun run scripts/sync-version.ts        # sync to root package.json version
//   bun run scripts/sync-version.ts 0.4.0  # set root + workspaces to 0.4.0
//   bun run scripts/sync-version.ts --check  # no writes; exit 1 on drift (CI guard)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT_PKG = join(REPO_ROOT, "package.json");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

function readJson(path: string): { version?: string; [k: string]: unknown } {
  return JSON.parse(readFileSync(path, "utf8")) as { version?: string };
}

function writePkg(path: string, pkg: Record<string, unknown>): void {
  // Match the project's existing indentation (2 spaces) + trailing newline so
  // the script's writes don't churn against the formatter.
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function listWorkspacePkgs(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(PACKAGES_DIR, entry.name, "package.json");
    try {
      readFileSync(pkgPath, "utf8");
      out.push(pkgPath);
    } catch {
      // package without a package.json — skip silently
    }
  }
  return out.sort();
}

function main(): void {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const explicitVersion = args.find((a) => !a.startsWith("--"));

  const rootPkg = readJson(ROOT_PKG) as Record<string, unknown> & { version?: string };
  const targetVersion = explicitVersion ?? rootPkg.version;
  if (typeof targetVersion !== "string" || targetVersion.length === 0) {
    console.error("error: no target version (root package.json has no `version`, no arg given)");
    process.exit(1);
  }

  const drift: { path: string; from: string; to: string }[] = [];

  // Root: bump only if an explicit version was passed AND it differs.
  if (explicitVersion !== undefined && rootPkg.version !== explicitVersion) {
    if (!checkOnly) {
      rootPkg.version = explicitVersion;
      writePkg(ROOT_PKG, rootPkg);
    }
    drift.push({ path: "package.json", from: String(rootPkg.version ?? ""), to: explicitVersion });
  }

  for (const pkgPath of listWorkspacePkgs()) {
    const pkg = readJson(pkgPath) as Record<string, unknown> & { version?: string };
    if (pkg.version === targetVersion) continue;
    drift.push({
      path: pkgPath.slice(REPO_ROOT.length + 1),
      from: pkg.version ?? "<unset>",
      to: targetVersion,
    });
    if (!checkOnly) {
      pkg.version = targetVersion;
      writePkg(pkgPath, pkg);
    }
  }

  if (drift.length === 0) {
    console.log(`✓ all workspaces at ${targetVersion}`);
    return;
  }

  for (const d of drift) {
    console.log(`${checkOnly ? "drift " : "set   "} ${d.path}: ${d.from} → ${d.to}`);
  }
  if (checkOnly) {
    console.error(`✗ ${drift.length} package(s) out of sync with ${targetVersion} (run \`bun run sync-version\`)`);
    process.exit(1);
  }
  console.log(`✓ synced ${drift.length} package(s) to ${targetVersion}`);
}

main();

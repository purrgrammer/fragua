// Discovery — scan `~/.swarm/extensions/` (user) and
// `<cwd>/.swarm/extensions/` (project) for extension entry points.
//
// Daemon-loadable shapes:
//   - flat:      <root>/<name>.ts
//   - directory: <root>/<name>/index.ts (with optional package.json + node_modules)
//
// Excluded: `*.web.tsx` and `*.tui.ts` siblings — those are loaded by
// their own host (web bundler / future TUI) and would crash the daemon
// on Node import (React / pi-tui peers).

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { DiscoveredExtension, ExtensionDiscoverOptions, ExtensionScope } from "./types.ts";

const ROOT_RELATIVE = ".swarm/extensions";

export async function discoverExtensions(opts: ExtensionDiscoverOptions): Promise<{
  discovered: DiscoveredExtension[];
  warnings: string[];
}> {
  const cfg = opts.config ?? {};
  const trustProject = cfg.trustProject ?? true;
  const disabledSet = new Set(cfg.disabled ?? []);

  const roots: Array<{ path: string; scope: ExtensionScope }> = [
    { path: resolve(opts.cwd, ROOT_RELATIVE), scope: "project" },
  ];
  if (opts.homeDir) {
    roots.push({ path: resolve(opts.homeDir, ROOT_RELATIVE), scope: "user" });
  }

  const warnings: string[] = [];
  const seenBasenames = new Map<string, DiscoveredExtension>();

  for (const root of roots) {
    const entries = await scanRoot(root.path, root.scope, warnings);
    for (const entry of entries) {
      if (disabledSet.has(entry.basename)) {
        entry.disabled_reason = `disabled by config (extensions.disabled includes "${entry.basename}")`;
      } else if (entry.scope === "project" && !trustProject) {
        entry.disabled_reason = "project scope hidden (extensions.trustProject=false)";
      }

      const existing = seenBasenames.get(entry.basename);
      if (!existing) {
        seenBasenames.set(entry.basename, entry);
        continue;
      }
      // Project beats user — entries arrive in (project, user) order so
      // a later user-scope hit gets shadowed.
      if (entry.scope === existing.scope) {
        warnings.push(
          `extension "${entry.basename}" duplicated in ${existing.scope} scope at ${existing.sourcePath} and ${entry.sourcePath} — keeping ${existing.sourcePath}`,
        );
      } else {
        warnings.push(
          `extension "${entry.basename}" at ${entry.sourcePath} (${entry.scope}) shadowed by ${existing.sourcePath} (${existing.scope})`,
        );
      }
    }
  }

  const discovered = [...seenBasenames.values()].sort((a, b) => a.basename.localeCompare(b.basename));
  return { discovered, warnings };
}

async function scanRoot(rootPath: string, scope: ExtensionScope, warnings: string[]): Promise<DiscoveredExtension[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await readdir(rootPath, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return []; // missing dir is fine — extension roots are optional
  }

  const out: DiscoveredExtension[] = [];

  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      const indexPath = resolve(rootPath, name, "index.ts");
      try {
        const s = await stat(indexPath);
        if (s.isFile()) {
          out.push({
            extensionId: `${scope}:${name}`,
            scope,
            sourcePath: indexPath,
            basename: name,
          });
        }
      } catch {
        // No index.ts — silently skip. Directories without an index.ts
        // may be assets / docs / paired renderer dirs.
      }
      continue;
    }

    if (!entry.isFile()) continue;

    // Skip paired renderer files — they belong to the web bundler / TUI host.
    if (name.endsWith(".web.tsx") || name.endsWith(".web.ts") || name.endsWith(".tui.ts")) {
      continue;
    }

    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    // Skip test files and the loader's own helpers.
    if (name.endsWith(".test.ts") || name.endsWith(".spec.ts")) continue;

    const basename = name.slice(0, -".ts".length);
    if (!isValidBasename(basename)) {
      warnings.push(
        `extension at ${resolve(rootPath, name)}: basename "${basename}" must match /^[a-z][a-z0-9_]*$/ (skipped)`,
      );
      continue;
    }

    out.push({
      extensionId: `${scope}:${basename}`,
      scope,
      sourcePath: resolve(rootPath, name),
      basename,
    });
  }

  return out;
}

const BASENAME_RE = /^[a-z][a-z0-9_]*$/;

function isValidBasename(s: string): boolean {
  return BASENAME_RE.test(s);
}

// Vite plugin: glob `*.web.tsx` paired-renderer files from
// `<repo>/.swarm/extensions/` (project) and `~/.swarm/extensions/`
// (user), exposed as a virtual module the conversation view consumes.
//
//   import { renderers } from "virtual:swarm-extensions";
//   // renderers: Map<string /* tool name */, WebRenderer>
//
// Project beats user on basename collision (mirrors the daemon-side
// loader). HMR: editing a `*.web.tsx` invalidates the virtual module
// so the registry reloads.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:swarm-extensions";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

interface PairedFile {
  basename: string;
  absPath: string;
  scope: "project" | "user";
}

export interface SwarmExtensionsPluginOptions {
  /** Repo / project root scanned for `<root>/.swarm/extensions/*.web.tsx`. */
  projectRoot: string;
  /** Override the user-scope home dir (tests). */
  homeDirOverride?: string;
}

export function swarmExtensionsPlugin(opts: SwarmExtensionsPluginOptions): Plugin {
  const home = opts.homeDirOverride ?? homedir();
  const roots: Array<{ path: string; scope: "project" | "user" }> = [
    { path: resolve(opts.projectRoot, ".swarm/extensions"), scope: "project" },
    { path: resolve(home, ".swarm/extensions"), scope: "user" },
  ];

  function scan(): PairedFile[] {
    const byBasename = new Map<string, PairedFile>();
    for (const root of roots) {
      if (!existsSync(root.path)) continue;
      let entries: string[];
      try {
        entries = readdirSync(root.path);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith(".web.tsx")) continue;
        const basename = name.slice(0, -".web.tsx".length);
        if (byBasename.has(basename)) continue; // project already won
        byBasename.set(basename, { basename, absPath: resolve(root.path, name), scope: root.scope });
      }
    }
    return [...byBasename.values()].sort((a, b) => a.basename.localeCompare(b.basename));
  }

  return {
    name: "swarm-extensions",
    enforce: "pre",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const files = scan();
      if (files.length === 0) {
        return `export const renderers = new Map();\n`;
      }
      // Each renderer file's default export is `WebRenderer`. The
      // `?import` query forces Vite to emit the file as a module rather
      // than asset-resolve it (some setups treat .tsx outside `src/` as
      // an asset). Absolute paths are honoured because we add each
      // root to `server.fs.allow` below.
      const imports = files.map((f, i) => `import r${i} from ${JSON.stringify(f.absPath)};`).join("\n");
      const entries = files.map((f, i) => `  [${JSON.stringify(f.basename)}, r${i}],`).join("\n");
      return `${imports}\nexport const renderers = new Map([\n${entries}\n]);\n`;
    },
    config() {
      // Vite refuses to serve modules outside server.fs.allow by default.
      // Allow the two extension roots so absolute imports above resolve.
      return {
        server: {
          fs: {
            allow: roots.map((r) => r.path),
          },
        },
      };
    },
    handleHotUpdate({ file, server }) {
      const isExt = roots.some((r) => file.startsWith(r.path) && file.endsWith(".web.tsx"));
      if (!isExt) return undefined;
      const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
      if (mod) return [mod, ...(server.moduleGraph.getModulesByFile(file) ?? [])];
      return undefined;
    },
  };
}

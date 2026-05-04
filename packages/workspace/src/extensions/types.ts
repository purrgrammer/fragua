// Internal types for the extension loader. The public type API for
// extension authors lives in `@swarm/extension`.

import type { ToolDefinition } from "@swarm/extension";
import type { AnyTool } from "../types.ts";

export type ExtensionScope = "user" | "project";

export interface ExtensionsConfig {
  /** Default true — set false to skip project-scope extensions while
   * still surfacing them in `extensions list`. */
  trustProject?: boolean;
  /** Hard-skip list keyed by extension basename. Applies across
   * scopes — a `disabled: ["audit"]` config skips both
   * `project:audit` and `user:audit`. */
  disabled?: string[];
}

export interface ExtensionDiscoverOptions {
  /** Project root. `<cwd>/.swarm/extensions/` is scanned. */
  cwd: string;
  /** User home dir. `<homeDir>/.swarm/extensions/` is scanned when set. */
  homeDir?: string;
  config?: ExtensionsConfig;
}

/** Discovered, not-yet-loaded extension file. */
export interface DiscoveredExtension {
  /** `<scope>:<basename>`. */
  extensionId: string;
  scope: ExtensionScope;
  /** Absolute path to the file the daemon will import. */
  sourcePath: string;
  /** Basename without `.ts` (or `index.ts`'s parent dirname for
   * directory-based extensions). Used for tool-name pairing. */
  basename: string;
  disabled_reason?: string;
}

/** Loaded extension after dynamic import + factory invocation. */
export interface LoadedExtension {
  extensionId: string;
  scope: ExtensionScope;
  sourcePath: string;
  basename: string;
  /** Tools the factory registered, already adapted to the workspace
   * `Tool` shape. */
  tools: AnyTool[];
  /** Raw `ToolDefinition`s preserved for descriptor-level metadata
   * (renderText, promptSnippet, promptGuidelines). */
  rawTools: Array<ToolDefinition<never, never>>;
  loadedAt: number;
  /** Set when the factory threw or no default-export was found. */
  error?: string;
}

export interface LoadResult {
  extensions: LoadedExtension[];
  /** Flat list of every successfully-loaded extension tool, in
   * (project-before-user, alphabetical) order. The daemon merges
   * this into its `ToolRegistry` alongside `CORE_TOOLS`. */
  tools: AnyTool[];
  warnings: string[];
}

// Public barrel for the extensions loader. The daemon imports
// `loadExtensions` and merges the returned tools into its
// `ToolRegistry` alongside `CORE_TOOLS`.

export { adaptExtensionTool } from "./adapter.ts";
export { discoverExtensions } from "./discover.ts";
export { loadExtensions } from "./loader.ts";
export type {
  DiscoveredExtension,
  ExtensionDiscoverOptions,
  ExtensionScope,
  ExtensionsConfig,
  LoadedExtension,
  LoadResult,
} from "./types.ts";

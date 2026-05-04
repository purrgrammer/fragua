// Orchestrate discovery → dynamic import → factory invocation →
// adapter. Returns a flat list of workspace tools the daemon merges
// into its `ToolRegistry`. Hot reload is not implemented in v0
// (deferred) — extensions are scanned once at daemon boot.
//
// Bun runs `.ts` files natively, so we use dynamic `import()` directly
// without jiti. A non-Bun runtime would crash; the daemon is a Bun
// process so this is fine.

import { pathToFileURL } from "node:url";
import type { ExtensionFactory, SwarmAPI, ToolDefinition } from "@swarm/extension";
import type { AnyTool } from "../types.ts";
import { adaptExtensionTool } from "./adapter.ts";
import { discoverExtensions } from "./discover.ts";
import type { DiscoveredExtension, ExtensionDiscoverOptions, LoadedExtension, LoadResult } from "./types.ts";

export async function loadExtensions(opts: ExtensionDiscoverOptions): Promise<LoadResult> {
  const { discovered, warnings } = await discoverExtensions(opts);
  const extensions: LoadedExtension[] = [];
  const tools: AnyTool[] = [];
  const collectedNames = new Map<string, string>();

  for (const entry of discovered) {
    if (entry.disabled_reason) {
      extensions.push({
        extensionId: entry.extensionId,
        scope: entry.scope,
        sourcePath: entry.sourcePath,
        basename: entry.basename,
        tools: [],
        rawTools: [],
        loadedAt: Date.now(),
        error: entry.disabled_reason,
      });
      continue;
    }

    const loaded = await loadOne(entry);
    extensions.push(loaded);
    if (loaded.error !== undefined) {
      warnings.push(`extension ${entry.extensionId}: ${loaded.error}`);
      continue;
    }

    for (const tool of loaded.tools) {
      const previous = collectedNames.get(tool.name);
      if (previous !== undefined) {
        warnings.push(
          `extension ${entry.extensionId}: tool "${tool.name}" already registered by ${previous} — skipping the duplicate`,
        );
        continue;
      }
      collectedNames.set(tool.name, entry.extensionId);
      tools.push(tool);
    }
  }

  return { extensions, tools, warnings };
}

async function loadOne(entry: DiscoveredExtension): Promise<LoadedExtension> {
  const collected: Array<ToolDefinition<never, never>> = [];
  const adapted: AnyTool[] = [];
  const seenToolNames = new Set<string>();

  const sw: SwarmAPI = {
    registerTool(tool) {
      if (seenToolNames.has(tool.name)) {
        throw new Error(
          `extension ${entry.extensionId} registered tool "${tool.name}" twice — names must be unique within an extension`,
        );
      }
      seenToolNames.add(tool.name);
      // Push the raw descriptor for metadata before adapting.
      collected.push(tool as ToolDefinition<never, never>);
      adapted.push(adaptExtensionTool(tool as ToolDefinition, { extensionId: entry.extensionId, scope: entry.scope }));
    },
  };

  let factory: ExtensionFactory;
  try {
    const url = pathToFileURL(entry.sourcePath).href;
    const mod = (await import(url)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      return errored(entry, `module has no default-export function (got ${typeof mod.default})`);
    }
    factory = mod.default as ExtensionFactory;
  } catch (err) {
    return errored(entry, `import failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await factory(sw);
  } catch (err) {
    return errored(entry, `factory threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    extensionId: entry.extensionId,
    scope: entry.scope,
    sourcePath: entry.sourcePath,
    basename: entry.basename,
    tools: adapted,
    rawTools: collected,
    loadedAt: Date.now(),
  };
}

function errored(entry: DiscoveredExtension, error: string): LoadedExtension {
  return {
    extensionId: entry.extensionId,
    scope: entry.scope,
    sourcePath: entry.sourcePath,
    basename: entry.basename,
    tools: [],
    rawTools: [],
    loadedAt: Date.now(),
    error,
  };
}

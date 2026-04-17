// Default GraphRenderer backed by @viz-js/viz (Graphviz compiled to WASM).
// Pure JS — no native bindings — so Bun + CI stays green on any OS.
//
// The Viz instance is expensive to construct (loads a ~1 MB wasm module), so
// we memoize it per adapter. Lazy: only loaded on first render, which means
// tests that never hit the graph route pay zero startup cost.

import type { GraphRenderer } from "../ports.ts";

export function createDotGraphRenderer(): GraphRenderer {
  let instancePromise: Promise<{ renderString: (dot: string, opts?: unknown) => string }> | null = null;

  async function getInstance(): Promise<{ renderString: (dot: string, opts?: unknown) => string }> {
    if (instancePromise) return instancePromise;
    instancePromise = (async () => {
      // Dynamic import so bundlers that never touch this adapter (e.g. the
      // web client reusing our schemas) don't pull in the wasm blob.
      const mod = (await import("@viz-js/viz")) as unknown as {
        instance: () => Promise<{ renderString: (dot: string, opts?: unknown) => string }>;
      };
      return await mod.instance();
    })();
    return instancePromise;
  }

  return {
    async render(dotSource: string): Promise<string> {
      const viz = await getInstance();
      // `engine: "dot"` is the layered DAG layout we want for workflows.
      const svg = viz.renderString(dotSource, { format: "svg", engine: "dot" });
      return svg;
    },
  };
}

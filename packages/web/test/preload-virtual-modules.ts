// bun:test doesn't see Vite's virtual modules. This preload provides
// stubs for any `virtual:*` imports so React components that consume
// them in production can still render under happy-dom.

import { plugin } from "bun";

plugin({
  name: "swarm-virtual-stubs",
  setup(build) {
    build.module("virtual:swarm-extensions", () => ({
      contents: "export const renderers = new Map();",
      loader: "ts",
    }));
  },
});

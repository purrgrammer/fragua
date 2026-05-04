// Type declaration for the virtual module emitted by
// `swarmExtensionsPlugin` (see ../vite/swarm-extensions.ts).

declare module "virtual:swarm-extensions" {
  import type { WebRenderer } from "@swarm/extension/web";
  export const renderers: Map<string, WebRenderer<unknown, unknown>>;
}

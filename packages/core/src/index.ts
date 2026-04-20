export const SWARM_CORE_VERSION = "0.0.0";

export * from "./engine/index.ts";
export * from "./executor/index.ts";
export * from "./parser/index.ts";
export * from "./types/index.ts";

// `handler/` is intentionally NOT re-exported here — it pulls in
// `@swarm/store` (which uses `bun:sqlite` + node built-ins). Import
// from `@swarm/core/handler` directly when you need it server-side.
// This keeps the main entry browser-safe so Vite's import-analysis
// doesn't choke on Bun built-ins.

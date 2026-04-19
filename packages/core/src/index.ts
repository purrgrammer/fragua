// @swarm/core — pure orchestrator. No I/O imports allowed in this package.
// See docs/SPEC.md §2 for the architecture and §3 for primitives.

export const SWARM_CORE_VERSION = "0.0.0";

export * from "./engine/index.ts";
export * from "./events/index.ts";
export * from "./executor/index.ts";
export * from "./interviewer/index.ts";
export * from "./parser/index.ts";
export * from "./types/index.ts";

// New handler surface for the DB-backed rearchitecture (REARCHITECTURE.md §5).
// Lives alongside the legacy surface until M5 cutover.
export * as handler from "./handler/index.ts";

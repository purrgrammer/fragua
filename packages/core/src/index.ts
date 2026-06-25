export const FRAGUA_CORE_VERSION = "0.0.0";

export * from "./duration.ts";
export * from "./engine/index.ts";
export * from "./executor/index.ts";
export * from "./ir.ts";
export * from "./parser/index.ts";
export * from "./provider-classification.ts";
export * from "./routing.ts";
export * from "./types/index.ts";
export * from "./uuid.ts";

// `handler/` is intentionally NOT re-exported here. It is a server-side
// helper surface (runtime clients, idempotency hashing, context wiring),
// while the main entry stays browser-safe for the web bundle. Import
// from `@fragua/core/handler` directly when you need handler execution
// primitives.

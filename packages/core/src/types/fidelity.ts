// Fidelity controls how much conversation history flows from one node to the
// next. See docs/SPEC.md §3.3.

export type FidelityMode = "full" | "truncate" | "compact" | "summary:low" | "summary:medium" | "summary:high";

export const DEFAULT_FIDELITY: FidelityMode = "compact";

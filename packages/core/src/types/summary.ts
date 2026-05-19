// Per-node summary level. When a node sets `summary=`, the summariser
// backend compresses the prior thread before the node sees it; the three
// values cap the summariser's output tokens. Without `summary=`, a node
// on a thread receives the full raw history.

export type SummaryLevel = "low" | "medium" | "high";

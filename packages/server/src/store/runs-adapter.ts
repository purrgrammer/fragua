// Store → RunSummary / RunDetail adapter.
//
// The projection logic moved to the shared read plane
// (`@fragua/core/read-plane`); re-exported here so existing server importers
// (and tests) keep their `./runs-adapter.ts` import path.

export {
  deriveNodeStates,
  deriveSelectedEdges,
  type ListRunsOpts,
  listRuns,
  mapStatus,
  runStateToDetail,
  runStateToSummary,
  runSummaryRowToSummary,
  type UiStatus,
} from "@fragua/core/read-plane";

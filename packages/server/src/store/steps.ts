// Pure reducer: StoredEvent[] → StepSnapshot[].
//
// The reducer logic moved to the shared read plane
// (`@fragua/core/read-plane`); re-exported here so existing server importers
// (and tests) keep their `./steps.ts` import path.

export {
  attachStepAggregates,
  eventsToSteps,
  fillOrphanDurations,
  type StepCostAggregate,
  type StepEvent,
  type StepSnapshot,
} from "@fragua/core/read-plane";

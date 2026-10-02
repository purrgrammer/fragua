export { allModels, realPair } from "./catalog-helpers.ts";
export {
  extractDeclarations,
  normalizeSource,
  type SourceHashGateOptions,
  sourceHashGate,
} from "./source-hash-gate.ts";
export {
  allowMarked,
  type CallInfo,
  callbackBodiesOf,
  collectAwaits,
  collectCalls,
  collectDestructurings,
  collectElementAccess,
  collectImports,
  collectMemberAccess,
  type DestructuringInfo,
  type ElementAccessInfo,
  type ImportInfo,
  lineOf,
  type MemberAccessInfo,
  parseSource,
  sameFileFunctionBodies,
  transitiveRelativeImports,
  typedBindings,
  walk,
} from "./ts-scan.ts";

// TypeBox schemas for intent-request bodies — the validated input the
// adapters (HTTP, CLI argv, dispatcher) deserialize into before the plane
// constructs an `IntentEvent`. Authored here, not relocated: the server
// validated these inline with hand-rolled `typeof` checks; this is the
// first single contract for what a valid intent request is.
//
// One schema per control-intent body. `additionalProperties: false` so a
// stray field is a validation error, not silently dropped. Numeric caps use
// `exclusiveMinimum: 0`, which also rejects NaN/Infinity — matching the
// routes' `Number.isFinite(x) && x > 0`.

import { type Static, Type } from "@sinclair/typebox";

const Note = Type.Optional(Type.String());
const NonEmpty = Type.String({ minLength: 1 });
const PositiveFinite = Type.Number({ exclusiveMinimum: 0 });

const opts = { additionalProperties: false } as const;

export const SteerBody = Type.Object({ text: NonEmpty }, opts);
export const PauseBody = Type.Object({}, opts);
export const CancelBody = Type.Object({ reason: Note }, opts);
export const HumanBody = Type.Object({ route: NonEmpty, note: Note }, opts);
export const ResumeBody = Type.Object({ note: Note }, opts);
export const UnquarantineBody = Type.Object(
  {
    resolution: Type.Union([Type.Literal("treat_as_done"), Type.Literal("retry"), Type.Literal("cancel")]),
    note: Note,
  },
  opts,
);
export const PriorityBody = Type.Object({ newPriority: Type.Number(), note: Note }, opts);
export const BudgetBody = Type.Object(
  {
    scope: Type.Union([Type.Literal("node"), Type.Literal("run")]),
    metric: Type.Union([Type.Literal("cost"), Type.Literal("tokens")]),
    newLimit: PositiveFinite,
    note: Note,
  },
  opts,
);
export const MaxRetriesBody = Type.Object({ nodeId: NonEmpty, newLimit: PositiveFinite, note: Note }, opts);
export const GoalGateBody = Type.Object({ newLimit: PositiveFinite, note: Note }, opts);
export const MaxLoopsBody = Type.Object({ newLimit: PositiveFinite, note: Note }, opts);

export type SteerBody = Static<typeof SteerBody>;
export type CancelBody = Static<typeof CancelBody>;
export type HumanBody = Static<typeof HumanBody>;
export type ResumeBody = Static<typeof ResumeBody>;
export type UnquarantineBody = Static<typeof UnquarantineBody>;
export type PriorityBody = Static<typeof PriorityBody>;
export type BudgetBody = Static<typeof BudgetBody>;
export type MaxRetriesBody = Static<typeof MaxRetriesBody>;
export type GoalGateBody = Static<typeof GoalGateBody>;
export type MaxLoopsBody = Static<typeof MaxLoopsBody>;

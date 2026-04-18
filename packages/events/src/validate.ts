// Runtime validation for events read back from JSONL. Useful for:
// - replay harnesses (fail fast on drifted fixtures)
// - server boundaries (reject malformed event uploads)
// - tests asserting a captured fixture's shape
//
// Keep this module thin: it composes TypeBox schemas from @swarm/core. The
// hot path of writing events stays pass-through — validation is opt-in.

import { Value } from "@sinclair/typebox/value";
import { EVENT_SCHEMA_VERSION, EventEnvelopeSchema, PAYLOAD_SCHEMAS } from "@swarm/core";

export interface ValidateOptions {
  /** When true, also run the payload-specific schema for event types in
   * `PAYLOAD_SCHEMAS`. Off by default because a single field rename on
   * `llm.start` would otherwise invalidate perfectly-usable fixtures from
   * older runs. Turn on for fresh captures and CI. */
  checkPayload?: boolean;
}

export type ValidateResult =
  | {
      ok: true;
      event: {
        run_id: string;
        type: string;
        timestamp: string;
        workflow_sha: string;
        data: unknown;
        schema_version?: number;
      };
    }
  | { ok: false; errors: string[] };

/** Validate a single raw object (typically JSON.parse of one JSONL line)
 * against the event envelope schema. On success the returned `event` is
 * narrowed to the envelope shape; callers are free to read `.data` with
 * their own narrowing. */
export function validateEvent(raw: unknown, opts: ValidateOptions = {}): ValidateResult {
  const envelopeErrors = [...Value.Errors(EventEnvelopeSchema, raw)].map((e) => `${e.path || "/"}: ${e.message}`);
  if (envelopeErrors.length > 0) return { ok: false, errors: envelopeErrors };

  const event = raw as {
    type: string;
    data: unknown;
    schema_version?: number;
    run_id: string;
    timestamp: string;
    workflow_sha: string;
  };

  if (opts.checkPayload && event.type in PAYLOAD_SCHEMAS) {
    const schema = PAYLOAD_SCHEMAS[event.type as keyof typeof PAYLOAD_SCHEMAS];
    const payloadErrors = [...Value.Errors(schema, event.data)].map((e) => `data${e.path}: ${e.message}`);
    if (payloadErrors.length > 0) return { ok: false, errors: payloadErrors };
  }

  return { ok: true, event };
}

/** Validate every event in an array, returning the index + errors of the
 * first failure. Use on the output of `readJsonlEvents` to smoke-test a
 * captured run in one call. */
export function validateEventStream(
  events: readonly unknown[],
  opts: ValidateOptions = {},
): { ok: true } | { ok: false; index: number; errors: string[] } {
  for (let i = 0; i < events.length; i++) {
    const result = validateEvent(events[i], opts);
    if (!result.ok) return { ok: false, index: i, errors: result.errors };
  }
  return { ok: true };
}

/** Current event envelope version as seen by this build. Re-exported from
 * @swarm/core so consumers don't need to reach across packages. */
export const CURRENT_EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;

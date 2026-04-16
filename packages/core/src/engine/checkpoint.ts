// Checkpoint serialize / deserialize. See docs/SPEC.md §3.6.

import { Value } from "@sinclair/typebox/value";
import { CHECKPOINT_SCHEMA_VERSION, type Checkpoint, CheckpointSchema } from "../types/checkpoint.ts";

export class CheckpointValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = "CheckpointValidationError";
  }
}

/** Serialize with sorted keys so the same logical checkpoint always produces
 * identical bytes (important for SHA comparison and testable replay). */
export function serializeCheckpoint(cp: Checkpoint): string {
  return stableStringify(cp);
}

/** Parse raw JSON and validate against the schema. Throws
 * CheckpointValidationError on structural issues. */
export function deserializeCheckpoint(raw: string): Checkpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CheckpointValidationError(`invalid JSON: ${msg}`, []);
  }
  if (!Value.Check(CheckpointSchema, parsed)) {
    const errors = [...Value.Errors(CheckpointSchema, parsed)].map((e) => ({
      path: e.path,
      message: e.message,
    }));
    throw new CheckpointValidationError(`checkpoint failed validation (${errors.length} issue(s))`, errors);
  }
  return parsed as Checkpoint;
}

/** Create a fresh checkpoint with the current schema version. */
export function createCheckpoint(partial: Omit<Checkpoint, "version">): Checkpoint {
  return { version: CHECKPOINT_SCHEMA_VERSION, ...partial };
}

/** Stable stringify: object keys sorted recursively, arrays left as-is. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",");
  return `{${body}}`;
}

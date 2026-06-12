// Structured step outputs — typed `outputs:` declarations on `llm` steps. A
// restricted JSON-Schema profile (scalars + records + arrays, nesting to any
// fixed depth) that both validates at parse time and lowers to provider-enforced
// TypeBox schemas. See docs/proposals/structured-outputs.md §3.

import { type TSchema, Type } from "@sinclair/typebox";

// ─────────────── Output type profile ───────────────

/** A scalar output field: string, number, boolean, or a closed-enum choice. */
export type OutputScalar =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "choice"; options: string[] };

/** An object output with typed named fields. Records/arrays nest to any fixed
 * depth (no recursion, no `$ref`). Fields are required unless declared
 * `optional: true`; the parser populates `required` as a sorted, de-duped
 * string[] (optional fields omitted) for canonicalization. */
export type OutputRecord = {
  kind: "record";
  fields: Record<string, OutputProfile>;
  required: string[];
};

/** A typed array of a single element type. */
export type OutputArray = {
  kind: "array";
  items: OutputProfile;
};

/** Discriminated union over the restricted profile. */
export type OutputProfile = OutputScalar | OutputRecord | OutputArray;

/** The whole outputs block on a node: a named record of profiles. */
export type OutputsDecl = Record<string, OutputProfile>;

// ─────────────── Runtime value types ───────────────

/** A JSON-safe value that satisfies an `OutputProfile`. `null` is included
 * because an `optional: true` field may be emitted as `null` ("no value"); a
 * direct `${{ outputs.X.f }}` read of such a leaf fails closed. */
export type OutputStructValue =
  | string
  | number
  | boolean
  | null
  | OutputStructValue[]
  | { [k: string]: OutputStructValue };

/** The runtime value a node emits: one entry per declared output field. */
export type OutputsValue = Record<string, OutputStructValue>;

// ─────────────── Profile guards ───────────────

export function isOutputScalar(p: OutputProfile): p is OutputScalar {
  return p.kind === "string" || p.kind === "number" || p.kind === "boolean" || p.kind === "choice";
}

export function isOutputRecord(p: OutputProfile): p is OutputRecord {
  return p.kind === "record";
}

export function isOutputArray(p: OutputProfile): p is OutputArray {
  return p.kind === "array";
}

// ─────────────── Canonicalization ───────────────

/** Sort `properties` keys, `required` entries, and `enum` values for a stable
 * hash surface (workflow-ir.md §8 freeze-facts bullet 3). Returns a deep copy
 * with canonical key ordering. */
export function canonicalizeOutputsDecl(decl: OutputsDecl): OutputsDecl {
  const out: OutputsDecl = {};
  for (const key of Object.keys(decl).sort()) {
    out[key] = canonicalizeProfile(decl[key]!);
  }
  return out;
}

function canonicalizeProfile(p: OutputProfile): OutputProfile {
  if (isOutputScalar(p)) {
    if (p.kind === "choice") {
      return { kind: "choice", options: [...p.options].sort() };
    }
    return p;
  }
  if (isOutputRecord(p)) {
    const fields: Record<string, OutputProfile> = {};
    for (const k of Object.keys(p.fields).sort()) {
      fields[k] = canonicalizeProfile(p.fields[k]!);
    }
    return { kind: "record", fields, required: [...p.required].sort() };
  }
  // array
  return { kind: "array", items: canonicalizeProfile(p.items) };
}

// ─────────────── TypeBox lowering (for emit_output / provider validation) ───

/** Lower an `OutputsDecl` to a TypeBox `TSchema` for use as the `emit_output`
 * tool's `parameters` schema. This is the one place where the restricted
 * profile maps to a provider-validated JSON Schema (TypeBox → Anthropic / OpenAI
 * tool-use validators). */
export function compileOutputsToTypeBox(decl: OutputsDecl): TSchema {
  // Lower the CANONICAL form so property order is stable (sorted keys, sorted
  // record fields) — otherwise author key order leaks into the schema bytes.
  // Top-level outputs are all required (emit_output must produce every declared
  // field), so `Type.Object` is correct here; only nested records carry a
  // partial `required`, handled literally in `profileToTypeBox`.
  const canonical = canonicalizeOutputsDecl(decl);
  const props: Record<string, TSchema> = {};
  for (const [key, profile] of Object.entries(canonical)) {
    props[key] = profileToTypeBox(profile);
  }
  return Type.Object(props, { additionalProperties: false });
}

function profileToTypeBox(p: OutputProfile): TSchema {
  if (p.kind === "string") return Type.String();
  if (p.kind === "number") return Type.Number();
  if (p.kind === "boolean") return Type.Boolean();
  if (p.kind === "choice") {
    // Use a bare JSON-Schema `enum` (not anyOf+const) — Anthropic validates
    // enum at the tool-call layer, anyOf+const is not reliably enforced.
    return Type.Unsafe<string>({ type: "string", enum: [...p.options].sort() });
  }
  if (p.kind === "record") {
    const requiredSet = new Set(p.required);
    const properties: Record<string, TSchema> = {};
    for (const [k, v] of Object.entries(p.fields)) {
      const compiled = profileToTypeBox(v);
      // A field absent from `required` is optional: it may be omitted, so its
      // value (when present) may also be null. Lower it to a nullable type so a
      // model that emits an explicit `null` (rather than omitting) still
      // satisfies the schema. Required fields keep their bare type.
      properties[k] = requiredSet.has(k) ? compiled : nullableSchema(compiled);
    }
    // Build the object schema literally. `Type.Object` recomputes `required`
    // from non-Optional properties and DISCARDS a `required` option — which
    // would force every field required, breaking declared-optional fields and
    // dropping the canonical (sorted) `required`. Emit it directly instead.
    return Type.Unsafe<Record<string, unknown>>({
      type: "object",
      properties,
      required: [...p.required].sort(),
      additionalProperties: false,
    });
  }
  // array
  return Type.Array(profileToTypeBox(p.items));
}

/** Lower a schema to its nullable form (`anyOf: [T, {type: null}]`) for an
 * optional record field — a model may emit an explicit `null` for it. */
function nullableSchema(s: TSchema): TSchema {
  return Type.Union([s, Type.Null()]);
}

// ─────────────── Runtime validation ───────────────

/** Validate a runtime value against a declared `OutputsDecl`.
 * Returns `null` on success, or an error message on failure.
 * Called at runtime after the `emit_output` tool call. */
export function validateOutputsValue(decl: OutputsDecl, value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "emit_output value must be a plain object";
  }
  const obj = value as Record<string, unknown>;
  for (const [key, profile] of Object.entries(decl)) {
    const fieldVal = obj[key];
    if (fieldVal === undefined) {
      return `missing required output field "${key}"`;
    }
    const err = validateValueAgainstProfile(profile, fieldVal, key);
    if (err !== null) return err;
  }
  // Match the lowered schema's `additionalProperties: false` — reject keys the
  // declaration doesn't list. The provider strips them under strict mode, so
  // this is our own backstop for non-strict providers.
  for (const key of Object.keys(obj)) {
    if (!(key in decl)) return `unexpected output field "${key}" (not declared)`;
  }
  return null;
}

function validateValueAgainstProfile(profile: OutputProfile, value: unknown, path: string): string | null {
  if (profile.kind === "string") {
    if (typeof value !== "string") return `field "${path}" must be a string, got ${typeof value}`;
    return null;
  }
  if (profile.kind === "number") {
    if (typeof value !== "number") return `field "${path}" must be a number, got ${typeof value}`;
    // Non-finite numbers (Infinity, -Infinity, NaN) are not representable in
    // JSON — JSON.stringify turns them into null, which a downstream
    // ${{ outputs.X.f }} substitution would inject as the literal string
    // "null" with no error. Reject at emit time so the producing node fails
    // loudly instead of emitting a poisoned value (reads fail closed).
    if (!Number.isFinite(value)) {
      return `field "${path}" must be a finite number, got ${String(value)} (Infinity/NaN are not JSON-representable and would degrade to null)`;
    }
    return null;
  }
  if (profile.kind === "boolean") {
    if (typeof value !== "boolean") return `field "${path}" must be a boolean, got ${typeof value}`;
    return null;
  }
  if (profile.kind === "choice") {
    if (typeof value !== "string") return `field "${path}" must be a string (choice), got ${typeof value}`;
    if (!profile.options.includes(value)) {
      return `field "${path}" value ${JSON.stringify(value)} not in choices ${JSON.stringify(profile.options)}`;
    }
    return null;
  }
  if (profile.kind === "record") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `field "${path}" must be a plain object`;
    }
    const obj = value as Record<string, unknown>;
    const requiredSet = new Set(profile.required);
    for (const req of profile.required) {
      if (obj[req] === undefined) return `field "${path}.${req}" is required but missing`;
    }
    for (const [k, v] of Object.entries(profile.fields)) {
      const fieldVal = obj[k];
      // Optional field (absent from `required`): may be omitted OR explicitly
      // null — both mean "no value". Only validate the type when a non-null
      // value is actually present.
      if (fieldVal === undefined) continue;
      if (fieldVal === null && !requiredSet.has(k)) continue;
      const err = validateValueAgainstProfile(v, fieldVal, `${path}.${k}`);
      if (err !== null) return err;
    }
    // Nested records are `additionalProperties: false` too.
    for (const k of Object.keys(obj)) {
      if (!(k in profile.fields)) return `field "${path}.${k}" is not a declared field`;
    }
    return null;
  }
  // array
  if (!Array.isArray(value)) return `field "${path}" must be an array`;
  for (let i = 0; i < value.length; i++) {
    const err = validateValueAgainstProfile(profile.items, value[i], `${path}[${i}]`);
    if (err !== null) return err;
  }
  return null;
}

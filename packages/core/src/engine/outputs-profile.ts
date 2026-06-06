// Parse and statically validate the `outputs:` block on llm/tool steps.
// See docs/proposals/structured-outputs.md §3.

import type { OutputArray, OutputProfile, OutputRecord, OutputScalar, OutputsDecl } from "../types/outputs.ts";
import type { Diagnostic } from "./validator.ts";

// ─────────────── Static profile validator ───────────────

/** Constructs E033 diagnostics for outputs declarations that use constructs
 * outside the restricted profile (pattern/format/min/max, oneOf/if/allOf,
 * $ref/recursion, cosmetic title). Also raises E034 for empty declarations,
 * duplicate keys, or non-identifier key names. Called by the validator after
 * the outputs block is parsed into an `OutputsDecl`. */
export function validateOutputsDeclStatic(
  decl: OutputsDecl,
  nodeId: string,
  loc?: { line: number; col: number },
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  if (Object.keys(decl).length === 0) {
    diags.push({
      severity: "error",
      code: "E034",
      message: `node "${nodeId}" declares \`outputs:\` with no fields — add at least one output`,
      nodeId,
      ...(loc !== undefined ? { loc } : {}),
    });
    return diags;
  }

  for (const [key, profile] of Object.entries(decl)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) {
      diags.push({
        severity: "error",
        code: "E034",
        message: `node "${nodeId}" output key "${key}" is not a valid identifier (must start with a letter, then letters/digits/underscore)`,
        nodeId,
        ...(loc !== undefined ? { loc } : {}),
      });
    }
    const sub = validateProfileNode(profile, nodeId, key, loc);
    for (const d of sub) diags.push(d);
  }

  return diags;
}

function validateProfileNode(
  profile: OutputProfile,
  nodeId: string,
  path: string,
  loc?: { line: number; col: number },
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (profile.kind === "choice") {
    if (profile.options.length === 0) {
      diags.push({
        severity: "error",
        code: "E033",
        message: `node "${nodeId}" output "${path}": choice type must declare at least one option`,
        nodeId,
        ...(loc !== undefined ? { loc } : {}),
      });
    }
  } else if (profile.kind === "record") {
    for (const [k, v] of Object.entries(profile.fields)) {
      const sub = validateProfileNode(v, nodeId, `${path}.${k}`, loc);
      for (const d of sub) diags.push(d);
    }
  } else if (profile.kind === "array") {
    const sub = validateProfileNode(profile.items, nodeId, `${path}[]`, loc);
    for (const d of sub) diags.push(d);
  }
  return diags;
}

// ─────────────── YAML-level parser ───────────────

/** Error thrown when an outputs: block uses a disallowed JSON-Schema construct.
 * Callers translate it into a ParseError at the appropriate source location. */
export class OutputsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputsProfileError";
  }
}

/** Parse a raw YAML-decoded object into an `OutputsDecl`.
 * Throws `OutputsProfileError` for any construct outside the restricted profile:
 * - Rejected keys: pattern, format, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   minLength, maxLength, minItems, maxItems, oneOf, if, allOf, $ref, title, anyOf.
 * - Allowed keys by type: type, enum, items, properties, required, fields, options.
 */
export function parseOutputsDecl(raw: unknown): OutputsDecl {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OutputsProfileError("`outputs:` must be a mapping of field names to type declarations");
  }
  const obj = raw as Record<string, unknown>;
  const decl: OutputsDecl = {};
  for (const [key, val] of Object.entries(obj)) {
    decl[key] = parseProfileNode(val, key);
  }
  return decl;
}

const BANNED_KEYS = new Set([
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "oneOf",
  "anyOf",
  "if",
  "then",
  "else",
  "allOf",
  "$ref",
  "title",
  "$id",
  "$schema",
  "not",
  "definitions",
  "$defs",
]);

function rejectBannedKeys(obj: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (BANNED_KEYS.has(key)) {
      throw new OutputsProfileError(
        `outputs profile at "${path}" uses disallowed JSON-Schema key "${key}" — ` +
          `the profile only allows: type, enum, items, properties, required, fields, options, kind. ` +
          `Constraints like pattern/format/min/max, combinators like oneOf/allOf, ` +
          `references ($ref), and cosmetic keys (title) are not supported.`,
      );
    }
  }
}

function parseProfileNode(raw: unknown, path: string): OutputProfile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OutputsProfileError(
      `outputs type at "${path}" must be a mapping (got ${Array.isArray(raw) ? "array" : typeof raw})`,
    );
  }
  const obj = raw as Record<string, unknown>;
  rejectBannedKeys(obj, path);

  const type = obj["type"];
  const kind = obj["kind"];

  // Support both `type: string` (JSON-Schema style) and `kind: string` (internal style).
  const resolved = typeof kind === "string" ? kind : typeof type === "string" ? type : undefined;

  if (resolved === "string") {
    return parseScalar("string", obj, path);
  }
  if (resolved === "number") {
    return parseScalar("number", obj, path);
  }
  if (resolved === "boolean") {
    return parseScalar("boolean", obj, path);
  }
  if (resolved === "choice") {
    return parseChoice(obj, path);
  }
  if (resolved === "object" || resolved === "record") {
    return parseRecord(obj, path);
  }
  if (resolved === "array") {
    return parseArray(obj, path);
  }

  // Check for `enum:` shorthand (implies choice).
  if (Array.isArray(obj["enum"])) {
    return choiceFromOptions(obj["enum"] as unknown[], path, "enum");
  }

  throw new OutputsProfileError(
    `outputs at "${path}": unknown or missing type (expected string/number/boolean/choice/object/array, ` +
      `got ${JSON.stringify(resolved)})`,
  );
}

function parseScalar(k: "string" | "number" | "boolean", _obj: Record<string, unknown>, _path: string): OutputScalar {
  return { kind: k };
}

function parseChoice(obj: Record<string, unknown>, path: string): OutputScalar {
  const options = obj["options"] ?? obj["enum"];
  if (!Array.isArray(options)) {
    throw new OutputsProfileError(`outputs at "${path}": choice type must declare "options" array`);
  }
  return choiceFromOptions(options as unknown[], path, "options");
}

/** Build a choice from a raw options/enum array. A non-string member is
 * REJECTED (not silently dropped) — `options: ["a", 2]` is an author error, not
 * a single-option choice. Requires at least one member. */
function choiceFromOptions(raw: unknown[], path: string, key: string): OutputScalar {
  for (const v of raw) {
    if (typeof v !== "string") {
      throw new OutputsProfileError(
        `outputs at "${path}": ${key} members must all be strings (got ${typeof v} ${JSON.stringify(v)})`,
      );
    }
  }
  if (raw.length === 0) {
    throw new OutputsProfileError(`outputs at "${path}": ${key} must have at least one string value`);
  }
  return { kind: "choice", options: raw as string[] } satisfies OutputScalar;
}

function parseRecord(obj: Record<string, unknown>, path: string): OutputRecord {
  // Support both `fields:` (internal style) and `properties:` (JSON-Schema style).
  const fieldsRaw = obj["fields"] ?? obj["properties"];
  if (typeof fieldsRaw !== "object" || fieldsRaw === null || Array.isArray(fieldsRaw)) {
    throw new OutputsProfileError(
      `outputs at "${path}": object/record type must declare "fields" (or "properties") mapping`,
    );
  }
  const fieldsObj = fieldsRaw as Record<string, unknown>;
  const fields: Record<string, OutputProfile> = {};
  for (const [k, v] of Object.entries(fieldsObj)) {
    fields[k] = parseProfileNode(v, `${path}.${k}`);
  }

  // `required` is optional — if omitted every field is required by convention.
  let required: string[];
  if (Array.isArray(obj["required"])) {
    required = (obj["required"] as unknown[]).filter((v): v is string => typeof v === "string");
    // Every required entry must name a declared field — otherwise the record is
    // un-satisfiable (the runtime validator would demand a field with no type).
    for (const r of required) {
      if (fields[r] === undefined) {
        throw new OutputsProfileError(`outputs at "${path}": required lists "${r}" but it is not a declared field`);
      }
    }
  } else {
    // Default: all declared fields are required.
    required = Object.keys(fields).sort();
  }

  return { kind: "record", fields, required: [...new Set(required)].sort() } satisfies OutputRecord;
}

function parseArray(obj: Record<string, unknown>, path: string): OutputArray {
  const itemsRaw = obj["items"];
  if (itemsRaw === undefined) {
    throw new OutputsProfileError(`outputs at "${path}": array type must declare "items"`);
  }
  const items = parseProfileNode(itemsRaw, `${path}[]`);
  return { kind: "array", items } satisfies OutputArray;
}

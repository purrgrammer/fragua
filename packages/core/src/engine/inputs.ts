// Run-input binding + validation. The workflow's `inputs:` block declares
// typed inputs (`InputDecl[]`); a run binds them via `--input name=value`.
//
//   - `resolveInputBindings` produces the string map the substitution
//     layer consumes: declared defaults overlaid by run-provided values.
//   - `validateInputBindings` enforces the declaration at enqueue time:
//     required inputs must be bound (or defaulted), choice inputs must
//     pick a declared option, and unknown keys are rejected.

import type { InputDecl } from "../types/graph.ts";
import { validateValueAgainstProfile } from "../types/outputs.ts";

export interface InputBindingError {
  code: "missing_required" | "invalid_choice" | "unknown_input" | "invalid_shape";
  name: string;
  message: string;
}

/** Object / array inputs carry a parsed type profile; scalars don't. */
export function isStructuredInput(d: InputDecl): boolean {
  return (d.type === "object" || d.type === "array") && d.profile !== undefined;
}

/** Decimal-number grammar for string-typed `number` inputs: optional sign, an
 * integer / fraction / both, optional exponent. Rejects hex / octal / binary
 * (`0x10`, `0o7`, `0b1`), `Infinity`, `NaN`, and blank / whitespace — none of
 * which a workflow author declaring `type: number` means by a decimal. */
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Coerce a single string value to a declared `number`, throwing a clean,
 * named error for blank / non-decimal / non-finite input. The one parser both
 * the coercion surface (`coerceInputBindings`) and the CLI plumbing share, so
 * the grammar can't drift between clients. */
export function coerceNumberInput(name: string, value: string): number {
  if (value.trim() === "") {
    throw new Error(`input "${name}" (type number) must not be blank`);
  }
  if (!DECIMAL_NUMBER.test(value.trim())) {
    throw new Error(`input "${name}" (type number) is not a decimal number: ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`input "${name}" (type number) is not a finite number: ${JSON.stringify(value)}`);
  }
  return n;
}

/** Coerce run-provided values to their declared scalar / structured type — the
 * SHARED step every enqueue path runs BEFORE `validateInputBindings`, so the
 * web UI (which POSTs raw strings) and any HTTP client get the same typed
 * values the CLI does without re-implementing coercion per client. A STRING
 * value is coerced by its declaration (number / boolean / object / array); a
 * non-string passes through untouched (an already-parsed `--input-json` value
 * or the schedule dispatcher's typed routing). Undeclared keys pass through for
 * `validateInputBindings` to reject as `unknown_input`. Failures surface as
 * `invalid_shape` errors, never a silent coercion.
 *
 * The returned `values` map is ALWAYS complete — every provided key gets an
 * entry, and a coercion failure leaves the original (uncoerced) string in place
 * alongside its `invalid_shape` error — so a caller that doesn't gate on
 * `errors.length` still sees the key (it would otherwise misread a failed
 * `invalid_shape` as a `missing_required` downstream). */
export function coerceInputBindings(
  decls: readonly InputDecl[] | undefined,
  provided: Readonly<Record<string, unknown>> = {},
): { values: Record<string, unknown>; errors: InputBindingError[] } {
  const declByName = new Map((decls ?? []).map((d) => [d.name, d]));
  const values: Record<string, unknown> = {};
  const errors: InputBindingError[] = [];
  for (const name of Object.keys(provided)) {
    // `JSON.parse` of an HTTP body produces `__proto__` as an own enumerable
    // key; assigning it would invoke the prototype setter on `values`. Skip it
    // here so the shared write surface matches the CLI ingress guard.
    if (name === "__proto__") continue;
    const v = provided[name];
    const decl = declByName.get(name);
    if (decl === undefined || typeof v !== "string") {
      values[name] = v;
      continue;
    }
    if (isStructuredInput(decl)) {
      try {
        values[name] = JSON.parse(v);
      } catch (err) {
        values[name] = v;
        errors.push({
          code: "invalid_shape",
          name,
          message: `input "${name}" (type ${decl.type}) is not valid JSON: ${(err as Error).message}`,
        });
      }
    } else if (decl.type === "number") {
      try {
        values[name] = coerceNumberInput(name, v);
      } catch (err) {
        values[name] = v;
        errors.push({ code: "invalid_shape", name, message: (err as Error).message });
      }
    } else if (decl.type === "boolean") {
      if (v !== "true" && v !== "false") {
        values[name] = v;
        errors.push({
          code: "invalid_shape",
          name,
          message: `input "${name}" (type boolean) must be "true" or "false", got ${JSON.stringify(v)}`,
        });
      } else {
        values[name] = v === "true";
      }
    } else {
      values[name] = v;
    }
  }
  return { values, errors };
}

/** Build the resolved `${{ inputs.x }}` map: declared defaults first, then
 * run-provided values win. Scalar values are coerced to strings (substitution
 * is textual); object / array inputs pass through as their parsed JSON value so
 * the substitution layer can dot-read into them. Provided keys with no matching
 * declaration are ignored here (the validator rejects them separately). */
export function resolveInputBindings(
  decls: readonly InputDecl[] | undefined,
  provided: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of decls ?? []) {
    if (d.default !== undefined) out[d.name] = isStructuredInput(d) ? d.default : String(d.default);
  }
  for (const d of decls ?? []) {
    // `Object.hasOwn` (not bracket access) so an optional input named
    // `constructor` / `toString` doesn't read the built-in off the prototype.
    const v = Object.hasOwn(provided, d.name) ? provided[d.name] : undefined;
    // `null` (reachable via `--input-json`) is "not provided" — mirror the
    // validator so an optional scalar keeps its default / collapses to "",
    // never renders the literal "null".
    if (v === undefined || v === null) continue;
    // Object / array inputs pass through as their parsed JSON value (the
    // substitution layer dot-reads them); scalars stay textual.
    out[d.name] = isStructuredInput(d) ? v : String(v);
  }
  return out;
}

/** Validate run-provided bindings against the declarations. Returns one
 * error per problem (empty array = valid). Required inputs without a
 * default and without a provided value fail; choice inputs whose value
 * isn't a declared option fail; provided keys not in the declaration
 * fail (typo guard). */
export function validateInputBindings(
  decls: readonly InputDecl[] | undefined,
  provided: Readonly<Record<string, unknown>> = {},
): InputBindingError[] {
  const errors: InputBindingError[] = [];
  const declByName = new Map((decls ?? []).map((d) => [d.name, d]));

  for (const d of decls ?? []) {
    const v = Object.hasOwn(provided, d.name) ? provided[d.name] : undefined;
    if (v === undefined || v === null) {
      if (d.required && d.default === undefined) {
        errors.push({
          code: "missing_required",
          name: d.name,
          message: `required input "${d.name}" was not provided`,
        });
      }
      continue;
    }
    if (d.type === "choice" && d.options !== undefined) {
      if (typeof v !== "string" || !d.options.includes(v)) {
        errors.push({
          code: "invalid_choice",
          name: d.name,
          message: `input "${d.name}" = ${JSON.stringify(v)} is not one of ${d.options.map((o) => JSON.stringify(o)).join(", ")}`,
        });
      }
      continue;
    }
    // Scalar inputs reject a non-scalar value handed in via `--input-json`:
    // `resolveInputBindings` would otherwise `String(v)` an object into
    // "[object Object]" and feed it to the prompt unannounced.
    if (
      (d.type === "string" && typeof v !== "string") ||
      (d.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) ||
      (d.type === "boolean" && typeof v !== "boolean")
    ) {
      errors.push({
        code: "invalid_shape",
        name: d.name,
        message: `input "${d.name}" expects a ${d.type} but got ${JSON.stringify(v)}`,
      });
      continue;
    }
    // Object / array inputs validate their parsed value against the SAME profile
    // grammar `outputs:` uses — the input analogue of a failed emit.
    if (isStructuredInput(d) && d.profile !== undefined) {
      const msg = validateValueAgainstProfile(d.profile, v, d.name);
      if (msg !== null) {
        errors.push({ code: "invalid_shape", name: d.name, message: `input "${d.name}": ${msg}` });
      }
    }
  }

  for (const name of Object.keys(provided)) {
    if (!declByName.has(name)) {
      errors.push({
        code: "unknown_input",
        name,
        message: `input "${name}" is not declared in the workflow's inputs: block`,
      });
    }
  }

  return errors;
}

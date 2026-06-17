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
    const v = provided[d.name];
    if (v === undefined) continue;
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
    const v = provided[d.name];
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
      (d.type === "number" && typeof v !== "number") ||
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
    if (d.profile !== undefined) {
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

// Run-input binding + validation. The workflow's `inputs:` block declares
// typed inputs (`InputDecl[]`); a run binds them via `--input name=value`.
//
//   - `resolveInputBindings` produces the string map the substitution
//     layer consumes: declared defaults overlaid by run-provided values.
//   - `validateInputBindings` enforces the declaration at enqueue time:
//     required inputs must be bound (or defaulted), choice inputs must
//     pick a declared option, and unknown keys are rejected.

import type { InputDecl } from "../types/graph.ts";

export interface InputBindingError {
  code: "missing_required" | "invalid_choice" | "unknown_input";
  name: string;
  message: string;
}

/** Build the resolved `${{ inputs.x }}` map: declared defaults first, then
 * run-provided values win. Everything is coerced to a string because
 * substitution is textual. Provided keys with no matching declaration are
 * ignored here (the validator rejects them separately). */
export function resolveInputBindings(
  decls: readonly InputDecl[] | undefined,
  provided: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of decls ?? []) {
    if (d.default !== undefined) out[d.name] = String(d.default);
  }
  for (const d of decls ?? []) {
    const v = provided[d.name];
    if (v !== undefined) out[d.name] = v;
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
  provided: Readonly<Record<string, string>> = {},
): InputBindingError[] {
  const errors: InputBindingError[] = [];
  const declByName = new Map((decls ?? []).map((d) => [d.name, d]));

  for (const d of decls ?? []) {
    const v = provided[d.name];
    if (v === undefined) {
      if (d.required && d.default === undefined) {
        errors.push({
          code: "missing_required",
          name: d.name,
          message: `required input "${d.name}" was not provided`,
        });
      }
      continue;
    }
    if (d.type === "choice" && d.options !== undefined && !d.options.includes(v)) {
      errors.push({
        code: "invalid_choice",
        name: d.name,
        message: `input "${d.name}" = ${JSON.stringify(v)} is not one of ${d.options.map((o) => JSON.stringify(o)).join(", ")}`,
      });
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

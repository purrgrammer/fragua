// Dynamic form rendered from a workflow's `inputs:` declarations.
//
// Each `WorkflowInputDecl` produces one labeled field:
//   string  → <Input type="text">
//   number  → <Input type="number">
//   boolean → native <input type="checkbox"> (no shadcn checkbox exists yet)
//   choice  → <Select> over the declared options
//
// The component is purely controlled: callers supply `value` (the current
// binding map) and `onChange` (called on every keystroke/toggle). Required
// fields with an empty or missing value propagate through `errors`.

import { useEffect } from "react";
import type { WorkflowInputDecl } from "../lib/api.ts";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

export interface WorkflowInputsFormProps {
  /** Declared inputs from the selected workflow. */
  inputs: WorkflowInputDecl[];
  /** Current binding map. Keys are input names; values are string-coerced. */
  value: Record<string, string>;
  /** Called whenever any field changes. The full binding map is passed. */
  onChange: (next: Record<string, string>) => void;
  /** Called with an array of input names that are required but unbound. */
  onErrors?: (missingRequired: string[]) => void;
}

function seedDefaults(inputs: WorkflowInputDecl[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of inputs) {
    if (decl.default !== undefined) {
      out[decl.name] = String(decl.default);
    }
  }
  return out;
}

function computeMissing(inputs: WorkflowInputDecl[], value: Record<string, string>): string[] {
  return inputs.filter((d) => d.required && (value[d.name] === undefined || value[d.name] === "")).map((d) => d.name);
}

export function WorkflowInputsForm({ inputs, value, onChange, onErrors }: WorkflowInputsFormProps): JSX.Element {
  // Seed defaults on first render / when inputs change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally omits value/onChange to seed defaults only when inputs change
  useEffect(() => {
    const defaults = seedDefaults(inputs);
    const next = { ...defaults, ...value };
    // Only call onChange when the merged map actually adds new keys.
    const added = Object.keys(defaults).some((k) => !(k in value));
    if (added) onChange(next);
  }, [inputs]);

  // Report missing required fields whenever value or inputs change.
  useEffect(() => {
    if (onErrors) {
      onErrors(computeMissing(inputs, value));
    }
  }, [inputs, value, onErrors]);

  const set = (name: string, raw: string): void => {
    onChange({ ...value, [name]: raw });
  };

  return (
    <div className="flex flex-col gap-2" data-testid="workflow-inputs-form">
      {inputs.map((decl) => {
        const current = value[decl.name] ?? "";
        const labelId = `wf-input-label-${decl.name}`;
        const fieldId = `wf-input-field-${decl.name}`;
        const missing = decl.required && current === "";

        return (
          <div key={decl.name} className="flex flex-col gap-1">
            <label
              id={labelId}
              htmlFor={fieldId}
              className="text-[length:var(--sw-text-xs)] text-[var(--sw-muted)] uppercase tracking-[0.06em]"
            >
              {decl.name}
              {decl.required && (
                <span aria-hidden className="ml-1 text-[var(--sw-accent-error)]">
                  *
                </span>
              )}
            </label>

            {decl.description && (
              <p className="text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">{decl.description}</p>
            )}

            {decl.type === "choice" && decl.options ? (
              <Select value={current} onValueChange={(v) => set(decl.name, v)}>
                <SelectTrigger
                  id={fieldId}
                  aria-labelledby={labelId}
                  aria-required={decl.required}
                  aria-invalid={missing}
                  data-testid={`wf-input-${decl.name}`}
                  className="w-full"
                >
                  <SelectValue placeholder={`Select ${decl.name}…`} />
                </SelectTrigger>
                <SelectContent>
                  {decl.options.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : decl.type === "boolean" ? (
              <div className="flex items-center gap-2">
                <input
                  id={fieldId}
                  type="checkbox"
                  aria-labelledby={labelId}
                  aria-required={decl.required}
                  data-testid={`wf-input-${decl.name}`}
                  checked={current === "true"}
                  onChange={(e) => set(decl.name, e.target.checked ? "true" : "false")}
                  className="size-4 cursor-pointer rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] accent-[var(--sw-text)]"
                />
              </div>
            ) : (
              <Input
                id={fieldId}
                type={decl.type === "number" ? "number" : "text"}
                aria-labelledby={labelId}
                aria-required={decl.required}
                aria-invalid={missing}
                data-testid={`wf-input-${decl.name}`}
                value={current}
                onChange={(e) => set(decl.name, e.target.value)}
                placeholder={decl.description ?? decl.name}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export { seedDefaults, computeMissing };

// Inline run composer: pick a workflow, fill typed inputs (when declared),
// type optional description, POST /runs.
//
// Source of truth for the workflow list is the parent — RunComposer never
// fetches the list. Names can collide across sources (a project-local
// workflow can share a `name` with a global one), so we key options by
// `${scope}:${path}` rather than by name.
//
// `workflowScope` is derived from each summary's `cwd`:
//   cwd === currentCwd  → "local"   (workflow lives under <currentCwd>/.swarm/workflows)
//   cwd == null         → "global"  (workflow lives under ~/.swarm/workflows)
//   anything else       → "path"    (workflow tied to a different project)
//
// When a workflow is selected the composer fetches its detail via
// `queries.workflows.detail` to get the parsed `inputs:` block.
// Typed inputs are rendered via `WorkflowInputsForm`; required inputs
// that are unbound keep the submit button disabled. The free-form
// `input` textarea remains for the run description / auto-title seed
// (separate from typed inputs per SPEC §3.8).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SelectGroup, SelectLabel } from "@/components/ui/select";
import { type CreateRunInput, createRun, type WorkflowSummary } from "../lib/api.ts";
import { queries } from "../lib/queries.ts";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./ai-elements/prompt-input.tsx";
import { WorkflowInputsForm } from "./WorkflowInputsForm.tsx";

export interface RunComposerProps {
  /** Project root the run will be enqueued against. Always sent on
   *  POST /runs, regardless of the workflow source. */
  cwd: string;
  /** All workflows the harness knows about (the unfiltered listing).
   *  RunComposer partitions them into project-local + global. */
  workflows: WorkflowSummary[];
}

type Scope = "local" | "global" | "path";

interface Option {
  id: string;
  scope: Scope;
  workflow: WorkflowSummary;
}

function scopeOf(w: WorkflowSummary, projectCwd: string): Scope {
  if (w.cwd === projectCwd) return "local";
  if (w.cwd == null) return "global";
  return "path";
}

function optionId(scope: Scope, path: string): string {
  return `${scope}:${path}`;
}

export function RunComposer({ cwd, workflows }: RunComposerProps): JSX.Element {
  const qc = useQueryClient();

  const { local, global } = useMemo(() => {
    const l: Option[] = [];
    const g: Option[] = [];
    for (const w of workflows) {
      const s = scopeOf(w, cwd);
      if (s === "local") l.push({ id: optionId(s, w.path), scope: s, workflow: w });
      else if (s === "global") g.push({ id: optionId(s, w.path), scope: s, workflow: w });
    }
    return { local: l, global: g };
  }, [workflows, cwd]);

  const optionsById = useMemo(() => {
    const m = new Map<string, Option>();
    for (const opt of [...local, ...global]) m.set(opt.id, opt);
    return m;
  }, [local, global]);

  const [selected, setSelected] = useState<string>("");
  const [input, setInput] = useState<string>("");
  // Typed input bindings: name → string value.
  const [typedInputs, setTypedInputs] = useState<Record<string, string>>({});
  // Names of required inputs that are currently unbound.
  const [missingRequired, setMissingRequired] = useState<string[]>([]);

  // Seed once a workflow becomes available. Don't overwrite on
  // subsequent listings — the operator may have picked manually since.
  useEffect(() => {
    if (selected) return;
    const first = local[0]?.id ?? global[0]?.id;
    if (first) setSelected(first);
  }, [selected, local, global]);

  // Reset typed inputs whenever a different workflow is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selected is the trigger; setters are stable
  useEffect(() => {
    setTypedInputs({});
    setMissingRequired([]);
  }, [selected]);

  // Fetch the detail for the currently selected workflow to get its inputs.
  const selectedOpt = selected ? optionsById.get(selected) : undefined;
  const selectedWorkflow = selectedOpt?.workflow;
  const detailQuery = useQuery({
    ...queries.workflows.detail(
      selectedWorkflow?.name ?? "",
      selectedOpt?.scope === "local" ? cwd : selectedOpt?.scope === "global" ? "" : undefined,
    ),
    enabled: selectedWorkflow !== undefined,
  });
  const declaredInputs = detailQuery.data?.inputs ?? [];

  const mutation = useMutation({
    mutationFn: (vars: CreateRunInput) => createRun(vars),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queries.runs.lists() });
      setInput("");
      setTypedInputs({});
    },
  });

  const canSubmit = selected.length > 0 && !mutation.isPending && missingRequired.length === 0;

  const submitStatus: "submitted" | "error" | undefined = mutation.isPending
    ? "submitted"
    : mutation.isError
      ? "error"
      : undefined;

  const errorMessage =
    mutation.error instanceof Error ? mutation.error.message : mutation.error ? String(mutation.error) : null;

  const handleSubmit = (message: PromptInputMessage): void => {
    const opt = optionsById.get(selected);
    if (!opt) return;
    const w = opt.workflow;
    const vars: CreateRunInput = {
      cwd,
      workflowName: w.name,
      workflowScope: opt.scope,
      input: message.text,
    };
    if (Object.keys(typedInputs).length > 0) {
      vars.inputs = typedInputs;
    }
    mutation.mutate(vars);
  };

  // Drop a stale enqueue error the moment the operator edits the
  // input. The submit button's status="error" state (rendered as an X
  // by PromptInputSubmit) and the inline error message both bind to
  // `mutation.error`, so resetting the mutation drops both at once.
  // isError + reset are read through a ref so this effect runs only
  // when `input` changes; depending on isError would re-trigger when
  // the error first appears and hide it instantly.
  const mutationRef = useRef({ isError: mutation.isError, reset: mutation.reset });
  mutationRef.current = { isError: mutation.isError, reset: mutation.reset };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` is the trigger; isError/reset are intentionally captured via ref so this effect only fires on input change.
  useEffect(() => {
    if (mutationRef.current.isError) mutationRef.current.reset();
  }, [input]);

  const hasOptions = local.length + global.length > 0;

  const handleErrors = useCallback((missing: string[]) => {
    setMissingRequired(missing);
  }, []);

  return (
    <div className="flex flex-col gap-[var(--sw-space-2)]" data-testid="run-composer">
      <PromptInput onSubmit={handleSubmit} data-testid="run-composer-form">
        <PromptInputHeader>
          <PromptInputTools>
            <PromptInputSelect
              value={selected}
              onValueChange={(v) => {
                if (v) setSelected(v);
              }}
              disabled={!hasOptions}
            >
              <PromptInputSelectTrigger data-testid="run-composer-trigger" aria-label="Workflow">
                <PromptInputSelectValue placeholder="Select workflow…" />
              </PromptInputSelectTrigger>
              <PromptInputSelectContent>
                {local.length > 0 && (
                  <SelectGroup>
                    <SelectLabel data-testid="run-composer-group-local">This project</SelectLabel>
                    {local.map((opt) => (
                      <PromptInputSelectItem
                        key={opt.id}
                        value={opt.id}
                        data-testid={`run-composer-item-local-${opt.workflow.name}`}
                      >
                        {opt.workflow.label ?? opt.workflow.name}
                      </PromptInputSelectItem>
                    ))}
                  </SelectGroup>
                )}
                {global.length > 0 && (
                  <SelectGroup>
                    <SelectLabel data-testid="run-composer-group-global">Global</SelectLabel>
                    {global.map((opt) => (
                      <PromptInputSelectItem
                        key={opt.id}
                        value={opt.id}
                        data-testid={`run-composer-item-global-${opt.workflow.name}`}
                      >
                        {opt.workflow.label ?? opt.workflow.name}
                      </PromptInputSelectItem>
                    ))}
                  </SelectGroup>
                )}
              </PromptInputSelectContent>
            </PromptInputSelect>
          </PromptInputTools>
        </PromptInputHeader>

        {declaredInputs.length > 0 && (
          <div className="px-[var(--sw-space-2)] py-[var(--sw-space-2)]">
            <WorkflowInputsForm
              inputs={declaredInputs}
              value={typedInputs}
              onChange={setTypedInputs}
              onErrors={handleErrors}
            />
          </div>
        )}

        <PromptInputTextarea
          placeholder={hasOptions ? "Describe what the workflow should do (optional)…" : "No workflows available"}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          data-testid="run-composer-input"
        />

        <PromptInputFooter>
          <PromptInputTools />
          <PromptInputSubmit disabled={!canSubmit} data-testid="run-composer-submit" status={submitStatus} />
        </PromptInputFooter>
      </PromptInput>

      {errorMessage && (
        <p className="text-xs text-[var(--sw-accent-error)]" role="alert" data-testid="run-composer-error">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

export default RunComposer;

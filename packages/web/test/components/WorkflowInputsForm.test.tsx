// WorkflowInputsForm — unit tests covering field rendering, default seeding,
// required-field validation, and choice validation.

import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowInputsForm } from "../../src/components/WorkflowInputsForm.tsx";
import type { WorkflowInputDecl } from "../../src/lib/api.ts";
import { renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function decl(name: string, type: WorkflowInputDecl["type"], opts: Partial<WorkflowInputDecl> = {}): WorkflowInputDecl {
  return {
    name,
    type,
    required: opts.required ?? false,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    ...(opts.options !== undefined ? { options: opts.options } : {}),
  };
}

describe("WorkflowInputsForm", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders one labeled field per InputDecl with type-appropriate control", () => {
    const inputs: WorkflowInputDecl[] = [
      decl("ticket", "string"),
      decl("count", "number"),
      decl("verbose", "boolean"),
      decl("mode", "choice", { options: ["fast", "thorough"] }),
    ];
    const { getByTestId } = renderWithClient(<WorkflowInputsForm inputs={inputs} value={{}} onChange={() => {}} />);

    // string → textarea
    const ticketEl = getByTestId("wf-input-ticket") as HTMLTextAreaElement;
    expect(ticketEl.tagName).toBe("TEXTAREA");

    // number → number input
    const countEl = getByTestId("wf-input-count") as HTMLInputElement;
    expect(countEl.tagName).toBe("INPUT");
    expect(countEl.type).toBe("number");

    // boolean → checkbox
    const verboseEl = getByTestId("wf-input-verbose") as HTMLInputElement;
    expect(verboseEl.tagName).toBe("INPUT");
    expect(verboseEl.type).toBe("checkbox");

    // choice → select trigger
    const modeEl = getByTestId("wf-input-mode");
    expect(modeEl.getAttribute("data-slot")).toBe("select-trigger");
  });

  it("seeds field values from decl.default and calls onChange with defaults on mount", async () => {
    const inputs: WorkflowInputDecl[] = [
      decl("priority", "string", { default: "medium" }),
      decl("dry_run", "boolean", { default: false }),
    ];

    let captured: Record<string, string> | undefined;
    renderWithClient(
      <WorkflowInputsForm
        inputs={inputs}
        value={{}}
        onChange={(next) => {
          captured = next;
        }}
      />,
    );

    // Wait for the useEffect that seeds defaults to fire.
    await act(async () => {});

    expect(captured).toBeDefined();
    expect(captured?.["priority"]).toBe("medium");
    expect(captured?.["dry_run"]).toBe("false");
  });

  it("required fields without a value emit a missing-required error to the parent", async () => {
    const inputs: WorkflowInputDecl[] = [decl("ticket", "string", { required: true }), decl("optional", "string")];

    let missing: string[] = [];
    renderWithClient(
      <WorkflowInputsForm
        inputs={inputs}
        value={{}}
        onChange={() => {}}
        onErrors={(m) => {
          missing = m;
        }}
      />,
    );

    await act(async () => {});

    expect(missing).toContain("ticket");
    expect(missing).not.toContain("optional");
  });

  it("required field with a value does not appear in missing errors", async () => {
    const inputs: WorkflowInputDecl[] = [decl("ticket", "string", { required: true })];
    let missing: string[] = ["placeholder"];

    renderWithClient(
      <WorkflowInputsForm
        inputs={inputs}
        value={{ ticket: "BUG-42" }}
        onChange={() => {}}
        onErrors={(m) => {
          missing = m;
        }}
      />,
    );

    await act(async () => {});

    expect(missing).toEqual([]);
  });

  it("string field reflects the supplied value prop", () => {
    const inputs: WorkflowInputDecl[] = [decl("ticket", "string")];

    const { getByTestId } = renderWithClient(
      <WorkflowInputsForm inputs={inputs} value={{ ticket: "BUG-42" }} onChange={() => {}} />,
    );

    const el = getByTestId("wf-input-ticket") as HTMLTextAreaElement;
    expect(el.value).toBe("BUG-42");
  });

  it("calls onChange with 'true'/'false' string when checkbox is toggled", () => {
    const inputs: WorkflowInputDecl[] = [decl("verbose", "boolean")];
    const calls: Array<Record<string, string>> = [];

    const { getByTestId } = renderWithClient(
      <WorkflowInputsForm inputs={inputs} value={{ verbose: "false" }} onChange={(next) => calls.push(next)} />,
    );

    // Checkbox responds to the native `change` event.
    const el = getByTestId("wf-input-verbose") as HTMLInputElement;
    fireEvent.click(el);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]?.["verbose"]).toBe("true");
  });
});

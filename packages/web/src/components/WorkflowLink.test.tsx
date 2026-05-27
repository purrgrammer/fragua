import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { WorkflowLink } from "./WorkflowLink.tsx";

function renderLink(ui: JSX.Element) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("WorkflowLink", () => {
  afterEach(() => cleanup());

  test("renders a Link to /workflows/:name with the name URL-encoded", () => {
    const { container } = renderLink(<WorkflowLink name="ci/gate" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/workflows/ci%2Fgate");
  });

  test("appends ?cwd= when cwd prop is provided (including empty string for global pin)", () => {
    const { container: c1 } = renderLink(<WorkflowLink name="ci-gate" cwd="/Users/dev/repo" />);
    const href1 = c1.querySelector("a")?.getAttribute("href") ?? "";
    expect(href1).toContain("?cwd=%2FUsers%2Fdev%2Frepo");

    cleanup();

    const { container: c2 } = renderLink(<WorkflowLink name="ci-gate" cwd="" />);
    const href2 = c2.querySelector("a")?.getAttribute("href") ?? "";
    expect(href2).toContain("?cwd=");
  });

  test("omits ?cwd when cwd prop is undefined", () => {
    const { container } = renderLink(<WorkflowLink name="ci-gate" />);
    const href = container.querySelector("a")?.getAttribute("href") ?? "";
    expect(href.includes("?")).toBe(false);
  });

  test("renders the label fallback to name when no children given", () => {
    const { container } = renderLink(<WorkflowLink name="my-workflow" />);
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("my-workflow");
  });

  test("renders children over label over name", () => {
    const { container } = renderLink(
      <WorkflowLink name="my-workflow" label="My Workflow">
        Custom
      </WorkflowLink>,
    );
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("Custom");
  });

  test("variant=badge wraps content in a Badge element inside the link", () => {
    const { container } = renderLink(<WorkflowLink name="ci-gate" variant="badge" />);
    const a = container.querySelector("a");
    expect(a).toBeTruthy();
    expect(a?.querySelector("[class*='truncate']")).toBeTruthy();
  });

  test("forwards data-testid to the underlying anchor", () => {
    const { container } = renderLink(<WorkflowLink name="ci-gate" data-testid="wf-link" />);
    expect(container.querySelector("[data-testid='wf-link']")).toBeTruthy();
  });
});

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { ProjectLink } from "./ProjectLink.tsx";

const PROJECT_ID = "019e4f5b-b2c8-7d7b-b413-10896ad2d708";

function renderLink(ui: JSX.Element) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ProjectLink", () => {
  afterEach(() => cleanup());

  test("renders a Link to /projects/:projectId using the literal project id", () => {
    const { container } = renderLink(<ProjectLink projectId={PROJECT_ID} name="fragua" />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe(`/projects/${PROJECT_ID}`);
  });

  test("renders the name as label by default and accepts a custom child label", () => {
    const { container: c1 } = renderLink(<ProjectLink projectId={PROJECT_ID} name="fragua" />);
    expect(c1.querySelector("a")?.textContent).toBe("fragua");

    cleanup();

    const { container: c2 } = renderLink(
      <ProjectLink projectId={PROJECT_ID} name="fragua">
        My Project
      </ProjectLink>,
    );
    expect(c2.querySelector("a")?.textContent).toBe("My Project");
  });

  test("forwards data-testid to the underlying anchor", () => {
    const { container } = renderLink(<ProjectLink projectId={PROJECT_ID} name="fragua" data-testid="proj-link" />);
    expect(container.querySelector("[data-testid='proj-link']")).toBeTruthy();
  });

  test("variant=mono applies font-mono class to the link", () => {
    const { container } = renderLink(<ProjectLink projectId={PROJECT_ID} name="fragua" variant="mono" />);
    const a = container.querySelector("a");
    expect(a?.className).toContain("font-mono");
  });

  test("variant=text applies muted text class to the link", () => {
    const { container } = renderLink(<ProjectLink projectId={PROJECT_ID} name="fragua" variant="text" />);
    const a = container.querySelector("a");
    expect(a?.className).toContain("text-sw-muted");
  });
});

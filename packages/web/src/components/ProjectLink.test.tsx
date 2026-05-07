import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useDom } from "../../test/setup.ts";
import { encodeProjectId } from "../lib/projectId.ts";
import { ProjectLink } from "./ProjectLink.tsx";

function renderLink(ui: JSX.Element) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ProjectLink", () => {
  useDom();
  afterEach(() => cleanup());

  test("renders a Link to /projects/:cwdEnc using base64url-encoded cwd", () => {
    const cwd = "/Users/dev/repo";
    const { container } = renderLink(<ProjectLink cwd={cwd} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe(`/projects/${encodeProjectId(cwd)}`);
  });

  test("renders the basename of cwd by default and accepts a custom child label", () => {
    const { container: c1 } = renderLink(<ProjectLink cwd="/Users/dev/repo" />);
    expect(c1.querySelector("a")?.textContent).toBe("repo");

    cleanup();

    const { container: c2 } = renderLink(<ProjectLink cwd="/Users/dev/repo">My Project</ProjectLink>);
    expect(c2.querySelector("a")?.textContent).toBe("My Project");
  });

  test("forwards data-testid to the underlying anchor", () => {
    const { container } = renderLink(<ProjectLink cwd="/Users/dev/repo" data-testid="proj-link" />);
    expect(container.querySelector("[data-testid='proj-link']")).toBeTruthy();
  });

  test("variant=mono applies font-mono class to the link", () => {
    const { container } = renderLink(<ProjectLink cwd="/Users/dev/repo" variant="mono" />);
    const a = container.querySelector("a");
    expect(a?.className).toContain("font-mono");
  });

  test("variant=text applies muted text class to the link", () => {
    const { container } = renderLink(<ProjectLink cwd="/Users/dev/repo" variant="text" />);
    const a = container.querySelector("a");
    expect(a?.className).toContain("text-sw-muted");
  });
});

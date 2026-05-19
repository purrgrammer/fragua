import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { HitlChoice } from "../../src/components/HitlChoice.tsx";
import { installFetchMock, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

describe("HitlChoice — labels + POST shape", () => {
  useDom();
  afterEach(() => cleanup());

  it("uses option.label when present, falls back to humanized key when label is empty", () => {
    const options = [
      { key: "small", label: "", to: "small_path" },
      { key: "large", label: "Big!", to: "large_path" },
      { key: "needs_info", label: "Need more info", to: "info_path" },
    ];
    const { container } = renderWithClient(<HitlChoice runId="run-1" options={options} />);
    const text = container.textContent ?? "";
    // Empty label → humanized key ("small" → "Small")
    expect(text).toContain("Small");
    // Non-empty label → verbatim
    expect(text).toContain("Big!");
    expect(text).toContain("Need more info");
  });

  it("POSTs { route, note } to /api/runs/:id/human on button click", async () => {
    const options = [{ key: "approve", label: "Approve", to: "ship" }];
    const HUMAN_URL = "/api/runs/run-42/human";
    const { calls, restore } = installFetchMock({
      [HUMAN_URL]: () =>
        new Response(JSON.stringify({ seq: 1 }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    });

    try {
      const { container } = renderWithClient(<HitlChoice runId="run-42" options={options} />);
      const btn = within(container).getByRole("button", { name: "Approve" });
      fireEvent.click(btn);

      // waitFor gives the React 18 mutation scheduler enough ticks.
      await waitFor(() => {
        expect(calls.find((c) => c.url === HUMAN_URL && c.method === "POST")).toBeDefined();
      });
    } finally {
      restore();
    }
  });

  it("renders nothing when options array is empty", () => {
    const { container } = renderWithClient(<HitlChoice runId="run-1" options={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

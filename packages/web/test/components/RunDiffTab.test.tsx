// RunDiffTab — comparison-target behaviour.
//
// The diff tab defaults to comparing against the run's base ref and offers
// "previous" as an alternative (matching the CLI's `--against`). Switching the
// control re-queries the diff with the new `against` param.

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test } from "vitest";
import { RunDiffTab } from "../../src/components/RunDiffTab.tsx";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";

const RUN_ID = "run-diff-1";

const SNAPSHOTS = [
  {
    eventIdx: 10,
    nodeId: "build",
    label: "step" as const,
    commitSha: "abc",
    treeSha: "def",
    committed: { filesChanged: 2, insertions: 10, deletions: 3 },
    uncommitted: null,
  },
  {
    eventIdx: 20,
    nodeId: "review",
    label: "step" as const,
    commitSha: "bcd",
    treeSha: "efg",
    committed: { filesChanged: 1, insertions: 5, deletions: 0 },
    uncommitted: null,
  },
];

function render(diffResponses: Record<string, string>) {
  const client = createTestQueryClient();
  const routes: Record<string, () => Response> = {
    [`/api/runs/${RUN_ID}/snapshots`]: () => json(SNAPSHOTS),
  };
  for (const [key, body] of Object.entries(diffResponses)) {
    routes[key] = () => new Response(body, { headers: { "content-type": "text/x-diff" } });
  }
  const mock = installFetchMock(routes, () => json([]));
  const result = renderWithClient(
    <MemoryRouter>
      <RunDiffTab runId={RUN_ID} />
    </MemoryRouter>,
    { client },
  );
  return { ...result, mock };
}

describe("RunDiffTab — comparison target", () => {
  afterEach(() => cleanup());

  test("defaults to base and offers previous, re-querying the diff when switched", async () => {
    const baseDiff = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new";
    const prevDiff = "--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y";
    const { container, mock } = render({
      [`/api/runs/${RUN_ID}/snapshots/20/diff?against=base`]: baseDiff,
      [`/api/runs/${RUN_ID}/snapshots/20/diff?against=previous`]: prevDiff,
    });
    try {
      // Default: the latest diffable snapshot (eventIdx=20) compared vs base.
      await waitFor(() => {
        expect(mock.calls.some((c) => c.url === `/api/runs/${RUN_ID}/snapshots/20/diff?against=base`)).toBe(true);
      });

      const against = within(container).getByTestId("run-diff-against");
      await act(async () => {
        fireEvent.click(against);
      });
      const previousOption = document.querySelector(`[data-testid="run-diff-against-previous"]`);
      expect(previousOption).not.toBeNull();
      await act(async () => {
        fireEvent.click(previousOption!);
      });

      await waitFor(() => {
        expect(mock.calls.some((c) => c.url === `/api/runs/${RUN_ID}/snapshots/20/diff?against=previous`)).toBe(true);
      });
    } finally {
      mock.restore();
    }
  });
});

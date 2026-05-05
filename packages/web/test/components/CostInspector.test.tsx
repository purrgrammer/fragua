// CostInspector renders one row per LLM call with model, duration,
// total cost, and a click-to-open context ring.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, waitFor, within } from "@testing-library/react";
import { CostInspector } from "../../src/components/CostInspector.tsx";
import type { ProviderDetail, ProviderModel, StepSnapshot } from "../../src/lib/api.ts";
import { createTestQueryClient, installFetchMock, json, renderWithClient } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

function makeStep(overrides: Partial<StepSnapshot> = {}): StepSnapshot {
  return {
    stepIdx: 0,
    startSeq: 0,
    nodeId: "plan",
    startedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function mount(runId: string, steps: StepSnapshot[], opts: { isLive?: boolean } = {}) {
  const client = createTestQueryClient();
  client.setQueryData(["runs", "steps", runId], steps);
  return renderWithClient(<CostInspector runId={runId} isLive={opts.isLive} />, { client });
}

describe("CostInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("shows a loading indicator, then renders one row per LLM call", async () => {
    const steps = [
      makeStep({ stepIdx: 0, startSeq: 1, nodeId: "plan" }),
      makeStep({ stepIdx: 1, startSeq: 2, nodeId: "implement", model: "claude-opus-4-7", provider: "anthropic" }),
    ];
    const client = createTestQueryClient();
    let resolve: (r: Response) => void = () => {};
    const mock = installFetchMock({
      "/api/runs/r1/steps": () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    });
    try {
      const { container } = renderWithClient(<CostInspector runId="r1" />, { client });
      const q = within(container);
      expect(q.getByTestId("cost-inspector-loading")).toBeTruthy();
      resolve(json(steps));
      await waitFor(() => {
        expect(q.getByTestId("cost-inspector")).toBeTruthy();
      });
      expect(q.getByTestId("step-0")).toBeTruthy();
      expect(q.getByTestId("step-1")).toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("empty array → empty state (not an error)", async () => {
    const { container } = mount("r1", []);
    await waitFor(() => {
      expect(within(container).getByTestId("cost-inspector-empty")).toBeTruthy();
    });
  });

  it("renders nodeId and total cost on each row (no provider/model chip)", async () => {
    // The row is intentionally cost-only — provider/model identification
    // belongs in the per-step popover via the context ring + breakdown.
    const steps = [
      makeStep({
        stepIdx: 0,
        startSeq: 1,
        nodeId: "verify",
        provider: "anthropic",
        model: "claude-sonnet-4.6",
        durationMs: 12_000,
        cost: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.05 },
      }),
    ];
    const { container } = mount("r1", steps);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    expect(q.getByText("verify")).toBeTruthy();
    // Provider/model chip removed — should not appear on the row strip.
    expect(q.queryByText("anthropic / claude-sonnet-4.6")).toBeNull();
    // Total cost lives in the metrics row; AnimatedNumber renders the formatted text.
    expect(q.getByText(/US\$0\.050|0\.050/)).toBeTruthy();
  });

  it("completed step renders durationMs as final, with no live marker", async () => {
    const steps = [makeStep({ stepIdx: 0, startSeq: 1, durationMs: 4_500 })];
    const { container } = mount("r1", steps);
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    const elapsed = q.getByTestId("step-0-elapsed");
    expect(elapsed).toBeTruthy();
    expect(elapsed.getAttribute("data-live")).toBeNull();
  });

  it("in-flight step on a live run renders a live elapsed chip", async () => {
    // No durationMs + isLive → CostInspector ticks `now - startedAt`
    // and marks the chip as live so styling/QA can target in-flight rows.
    const startedAt = new Date(Date.now() - 3000).toISOString();
    const steps = [makeStep({ stepIdx: 0, startSeq: 1, startedAt })];
    const { container } = mount("r1", steps, { isLive: true });
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    const elapsed = q.getByTestId("step-0-elapsed");
    expect(elapsed.getAttribute("data-live")).toBe("true");
    expect(elapsed.textContent).toMatch(/\d/);
  });

  it("orphan mid-list step falls back to next.startedAt − this.startedAt client-side", async () => {
    // Defensive: the server fills durationMs for orphan steps via
    // fillOrphanDurations, but if a stale backend doesn't, the client
    // still derives a duration from the next step's startedAt.
    const t0 = "2024-01-01T00:00:00.000Z";
    const t1 = "2024-01-01T00:00:07.000Z"; // next step starts 7s later
    const steps = [
      makeStep({ stepIdx: 0, startSeq: 1, nodeId: "implement", startedAt: t0 }), // no durationMs
      makeStep({ stepIdx: 1, startSeq: 2, nodeId: "verify", startedAt: t1, durationMs: 3_000 }),
    ];
    const { container } = mount("r1", steps, { isLive: false });
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    const elapsed = q.getByTestId("step-0-elapsed");
    expect(elapsed).toBeTruthy();
    // Client computed elapsed from next.startedAt − this.startedAt = 7s.
    expect(elapsed.textContent).toMatch(/7\s*s/);
    // Not marked live — it's a derived value, not a ticking one.
    expect(elapsed.getAttribute("data-live")).toBeNull();
  });

  describe("CostInspector — parallel branches", () => {
    it("indents step rows with parentNodeId under their parent and shows a parent summary aggregating cost + tokens", async () => {
      const steps = [
        makeStep({
          stepIdx: 0,
          startSeq: 1,
          nodeId: "fork",
          cost: { input_tokens: 50, output_tokens: 50, cost_usd: 0.01 },
        }),
        makeStep({
          stepIdx: 1,
          startSeq: 2,
          nodeId: "lensA",
          parentNodeId: "fork",
          parallelIndex: 0,
          cost: { input_tokens: 100, output_tokens: 100, cost_usd: 0.02 },
        }),
        makeStep({
          stepIdx: 2,
          startSeq: 3,
          nodeId: "lensB",
          parentNodeId: "fork",
          parallelIndex: 1,
          cost: { input_tokens: 150, output_tokens: 150, cost_usd: 0.03 },
        }),
      ];
      const { container } = mount("r1", steps);
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("step-0")).toBeTruthy();
      });
      const parent = q.getByTestId("step-0");
      const lensA = q.getByTestId("step-1");
      const lensB = q.getByTestId("step-2");
      // Parent has children → summary marker + summed cost ($0.06).
      expect(parent.getAttribute("data-summary")).toBe("true");
      expect(parent.textContent).toMatch(/0\.06/);
      // Children carry the parentNodeId attribution + branch-child class.
      expect(lensA.getAttribute("data-branch-child")).toBe("true");
      expect(lensA.getAttribute("data-parent-step")).toBe("fork");
      expect(lensB.getAttribute("data-branch-child")).toBe("true");
      expect(lensB.getAttribute("data-parent-step")).toBe("fork");
      // Indent class lands on the row container.
      expect(lensA.className).toMatch(/ml-6/);
      expect(lensB.className).toMatch(/ml-6/);
      // Children render their own (non-summed) cost.
      expect(lensA.textContent).toMatch(/0\.02/);
      expect(lensB.textContent).toMatch(/0\.03/);
    });
  });

  describe("billed token reconciliation", () => {
    // Pinned rate card so the four breakdown rows have predictable
    // dollar figures: input 3, output 15, cacheRead 0.3, cacheWrite
    // 3.75 (USD per million tokens). Context window 200k keeps the
    // gauge percent < 1% so the trigger label is unambiguous.
    const RATE_MODEL: ProviderModel = {
      id: "claude-sonnet-4.6",
      name: "Claude Sonnet 4.6",
      api: "anthropic",
      reasoning: false,
      input: ["text"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200_000,
      maxTokens: 8192,
      baseUrl: "",
    };
    const PROVIDER: ProviderDetail = {
      name: "anthropic",
      model_count: 1,
      credentialed: true,
      auth_source: "env",
      auth_kind: null,
      oauth_available: false,
      default_model: "claude-sonnet-4.6",
      models: [RATE_MODEL],
    };

    function mountWithModel(steps: StepSnapshot[]) {
      const client = createTestQueryClient();
      client.setQueryData(["runs", "steps", "r-cache"], steps);
      client.setQueryData(["providers", "detail", "anthropic"], PROVIDER);
      return renderWithClient(<CostInspector runId="r-cache" />, { client });
    }

    const cacheStep: StepSnapshot = makeStep({
      stepIdx: 0,
      startSeq: 1,
      nodeId: "plan",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
      durationMs: 1_000,
      cost: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 1000,
        cache_write_tokens: 500,
        cost_usd: 0.01,
      },
    });

    it("context gauge usedTokens equals fresh = input + cache_write + output (650 / 200000 ≈ 0.3%)", async () => {
      // Per-step gauge tracks fresh tokens — new content this step
      // contributed (input + cache_write + output). Cache_read is reused
      // content from a prior turn's cache_write, already counted there;
      // including it would inflate the gauge to ~95% on warm threads
      // even when actual new work is single-digit tokens. The headline
      // run-level tile uses billed (= fresh + cache_read) for the
      // invoice match — different signals, different surfaces.
      //
      // With input=100 + cache_write=500 + output=50 the trigger renders
      // 650/200000 = 0.325% → "0.3%" (maxFractionDigits=1).
      //
      // The popover's per-bucket rows (Input 100 / Cache write 500 /
      // Cache read 1000 / Output 50, each with own $) can't be asserted
      // here: Radix portals don't mount under happy-dom because globals
      // are registered after radix imports run — see
      // `test/routes/WorkflowDetail.test.tsx` ("renders no inspector by
      // default …"). The math lives in inline expressions in
      // CostInspector.tsx; the gauge percent here covers the fresh-sum
      // end-to-end.
      const { container } = mountWithModel([cacheStep]);
      const q = within(container);
      await waitFor(() => {
        expect(q.getByTestId("step-0")).toBeTruthy();
      });
      expect(q.getByText("0.3%")).toBeTruthy();
    });
  });

  it("in-flight step on a non-live run hides the elapsed chip (no stale tick)", async () => {
    // The server fills durationMs for orphan steps on terminal runs.
    // If it didn't (older snapshot, edge case), the client must NOT show
    // a `now - startedAt` value — that would grow forever for runs
    // viewed days after they ended.
    const startedAt = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString(); // 9 hours ago
    const steps = [makeStep({ stepIdx: 0, startSeq: 1, startedAt })];
    const { container } = mount("r1", steps, { isLive: false });
    const q = within(container);
    await waitFor(() => {
      expect(q.getByTestId("step-0")).toBeTruthy();
    });
    expect(q.queryByTestId("step-0-elapsed")).toBeNull();
  });
});

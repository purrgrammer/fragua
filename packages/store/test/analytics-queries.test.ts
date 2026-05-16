import { describe, expect, test } from "bun:test";
import { freshStore } from "./helpers.ts";

const FAR_FUTURE = 9_999_999_999_999;

describe("getFirstRunAt", () => {
  test("empty run_state returns null", () => {
    const store = freshStore();
    const result = store.getFirstRunAt({ fromMs: 0, toMs: FAR_FUTURE });
    expect(result).toBeNull();
    store.close();
  });

  test("single run returns its enqueued_at", () => {
    // freshStore starts its clock at 1_700_000_000_000 and increments
    // by 1 on each call. The first enqueueRun captures that timestamp.
    const store = freshStore(1_700_000_000_000);
    store.saveWorkflow("wf1", "test", "digraph G { a -> b }");
    store.enqueueRun({ runId: "run1", workflowSha: "wf1" });
    const result = store.getFirstRunAt({ fromMs: 0, toMs: FAR_FUTURE });
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(1_700_000_000_000);
    store.close();
  });

  test("multiple runs returns the minimum enqueued_at", () => {
    const store = freshStore(1_000);
    store.saveWorkflow("wf1", "test", "digraph G { a -> b }");
    // Three runs enqueued in order — clock increments each call, so
    // run1 gets the earliest timestamp.
    store.enqueueRun({ runId: "run1", workflowSha: "wf1" });
    store.enqueueRun({ runId: "run2", workflowSha: "wf1" });
    store.enqueueRun({ runId: "run3", workflowSha: "wf1" });

    // Fetch the actual enqueued_at for run1 via getFirstRunAt on a
    // narrow window that only catches run1.
    const earliestAll = store.getFirstRunAt({ fromMs: 0, toMs: FAR_FUTURE });
    const run1Only = store.getFirstRunAt({ fromMs: 0, toMs: 1_002 });
    // earliestAll must equal the run1-only window value
    expect(earliestAll).not.toBeNull();
    expect(run1Only).not.toBeNull();
    expect(earliestAll).toBe(run1Only);
    store.close();
  });

  test("cwd filter scopes the minimum to that project", () => {
    // Two runs in cwd /project-a (older), one run in cwd /project-b.
    const store = freshStore(1_000);
    store.saveWorkflow("wf1", "test", "digraph G { a -> b }");
    store.enqueueRun({ runId: "a1", workflowSha: "wf1", cwd: "/project-a" });
    store.enqueueRun({ runId: "a2", workflowSha: "wf1", cwd: "/project-a" });
    store.enqueueRun({ runId: "b1", workflowSha: "wf1", cwd: "/project-b" });

    const globalMin = store.getFirstRunAt({ fromMs: 0, toMs: FAR_FUTURE });
    const projectBMin = store.getFirstRunAt({ fromMs: 0, toMs: FAR_FUTURE, cwd: "/project-b" });

    // Global min should be from /project-a (runs at t=1000, t=1001)
    // Project-b min should be from the /project-b run (t=1002)
    expect(globalMin).not.toBeNull();
    expect(projectBMin).not.toBeNull();
    // /project-b was enqueued after /project-a runs, so its min is
    // strictly greater than the global min.
    expect(projectBMin!).toBeGreaterThan(globalMin!);
    store.close();
  });

  test("workflowScope+name filter scopes the minimum to that workflow identity", () => {
    const store = freshStore(5_000);
    store.saveWorkflow("wf_global", "global-flow", "digraph G { a -> b }");
    store.saveWorkflow("wf_local", "local-flow", "digraph G { a -> b }");

    // Enqueue: global-flow first, local-flow second (later timestamp)
    store.enqueueRun({
      runId: "g1",
      workflowSha: "wf_global",
      workflowScope: "global",
      workflowName: "global-flow",
    });
    store.enqueueRun({
      runId: "l1",
      workflowSha: "wf_local",
      workflowScope: "local",
      workflowName: "local-flow",
      cwd: "/proj",
    });

    const globalFlowMin = store.getFirstRunAt({
      fromMs: 0,
      toMs: FAR_FUTURE,
      workflowScope: "global",
      workflowName: "global-flow",
    });
    const localFlowMin = store.getFirstRunAt({
      fromMs: 0,
      toMs: FAR_FUTURE,
      workflowScope: "local",
      workflowName: "local-flow",
    });

    expect(globalFlowMin).not.toBeNull();
    expect(localFlowMin).not.toBeNull();
    // global-flow was enqueued first → smaller timestamp
    expect(globalFlowMin!).toBeLessThan(localFlowMin!);
    store.close();
  });

  test("window time bounds are applied — runs outside the window are excluded", () => {
    const store = freshStore(1_000);
    store.saveWorkflow("wf1", "test", "digraph G { a -> b }");
    store.enqueueRun({ runId: "early", workflowSha: "wf1" }); // t=1000
    store.enqueueRun({ runId: "late", workflowSha: "wf1" }); // t=1001

    // Window that excludes the earliest run
    const result = store.getFirstRunAt({ fromMs: 1_001, toMs: FAR_FUTURE });
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThanOrEqual(1_001);

    // Window that excludes everything
    const resultEmpty = store.getFirstRunAt({ fromMs: 9_000, toMs: FAR_FUTURE });
    expect(resultEmpty).toBeNull();
    store.close();
  });
});

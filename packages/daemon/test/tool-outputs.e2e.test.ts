// End-to-end: a `tool` step declares typed `outputs:`, writes them to
// `$FRAGUA_OUTPUT`, and the struct flows forward — resolved in a downstream
// tool `run:` and projected into the run-level `outputs:` envelope. Driven
// through the REAL tool handler + a real LocalEnvironment over an ephemeral
// store, no scripting of the producer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, type ExecutionEnvironment, type Graph, parseWorkflow, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { makeReadPlane } from "@fragua/core/read-plane";
import { SqliteStore } from "@fragua/store";
import { LocalEnvironment } from "@fragua/workspace";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import type { SnapshotResult } from "../src/snapshotter.ts";
import type { Provisioner } from "../src/worktree-provisioner.ts";

const TERMINAL = new Set(["completed", "halted", "cancelled"]);

/** A one-env provisioner backed by a real LocalEnvironment rooted at `cwd`. */
class LocalProvisioner implements Provisioner {
  private env: ExecutionEnvironment;
  constructor(cwd: string) {
    this.env = new LocalEnvironment({ cwd });
  }
  async ensure(): Promise<ExecutionEnvironment> {
    return this.env;
  }
  async dispose(): Promise<void> {}
  envFor(): ExecutionEnvironment {
    return this.env;
  }
  baseGitSha(): string | null {
    return null;
  }
  baseGitRef(): string | null {
    return null;
  }
  async snapshot(): Promise<SnapshotResult | null> {
    return null;
  }
}

const SOURCE = [
  "name: tool-outputs-e2e",
  "outputs:",
  "  branch: { from: produce.branch }",
  "steps:",
  "  produce:",
  "    type: tool",
  `    run: printf '{"branch":"feat-x"}' > "$FRAGUA_OUTPUT"`,
  "    outputs:",
  "      branch: { type: string }",
  "    next: consume",
  "  consume:",
  "    type: tool",
  "    run: printf '%s' ${{ outputs.produce.branch }} > consumed.txt",
  "    next: exit",
].join("\n");

describe("e2e: tool step producing typed outputs via $FRAGUA_OUTPUT", () => {
  test("emits, resolves in a downstream tool run:, and projects run-level outputs", async () => {
    const graph: Graph = parseWorkflow(SOURCE);
    const dir = mkdtempSync(join(tmpdir(), "fragua-tool-outputs-"));
    let now = 1_700_000_000_000;
    const clock = () => ++now;
    const store = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
    try {
      const sha = "tool-outputs";
      store.saveWorkflow(sha, graph.id, SOURCE, serializeGraph(graph), CURRENT_IR_VERSION);

      const dispatcher = new Dispatcher();
      dispatcher.setResolver(autoDispatcherResolver({ store }));

      const runId = "tool-outputs-run";
      store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" }, cwd: dir });

      const runOpts = {
        store,
        dispatcher,
        registry: new AbortRegistry(),
        tools: new handler.InMemoryToolRegistry(),
        llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 50,
        shutdownSignal: new AbortController().signal,
        clock,
        random: () => 0.5,
        provisioner: new LocalProvisioner(dir),
      };

      for (let step = 0; step < 50; step++) {
        store.claimNextRun(1);
        await runOne(runId, runOpts);
        const st = store.getState(runId);
        if (st === null || TERMINAL.has(st.status)) break;
      }

      const state = store.getState(runId);
      expect(state?.status).toBe("completed");

      // The producer's struct landed in the rebuildable outputs index.
      expect(store.getLatestOutput(runId, "produce")).toBe('{"branch":"feat-x"}');

      // `${{ outputs.produce.branch }}` resolved in the consumer's `run:`.
      expect(readFileSync(join(dir, "consumed.txt"), "utf8")).toBe("feat-x");

      // Run-level `outputs:` projects from the tool producer through the read plane.
      const detail = makeReadPlane({ store }).runDetail(runId);
      expect(detail?.outputs).toEqual({ branch: "feat-x" });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

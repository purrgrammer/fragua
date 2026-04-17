// Exercises the review-gate loop pattern used in workflows/build-feature.dot:
// a trapezium node iterates until the implementer emits <promise>APPROVED</promise>.
// We drive it with the faux provider so every LLM call is deterministic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, fauxToolCall, type PiMockBackendHandle } from "../src/mock.ts";

const LOOP_ONLY_WORKFLOW = `
  digraph {
    graph [default_fidelity="compact"]
    s [shape=Mdiamond]
    implement_and_review [
      shape=trapezium,
      until="APPROVED",
      max_iterations=3,
      prompt="implement; review; emit APPROVED when good",
      thread_id="dev"
    ]
    done [shape=Msquare]
    s -> implement_and_review -> done
  }
`;

describe("build-feature review-gate loop (trapezium)", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-loop-"));
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    mock = createPiMockBackend({ registry, env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("approves on first iteration — single loop pass", async () => {
    // Iteration 1: write a file, then emit APPROVED in the same turn.
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall("local__write_file", { path: "out.txt", contents: "shipped" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("<promise>APPROVED</promise>", { stopReason: "stop" }),
    ]);

    const sink = new InMemorySink();
    const res = await execute({
      graph: parseDotSource(LOOP_ONLY_WORKFLOW),
      sink,
      backend: mock.backend,
    });

    expect(res.outcome.status).toBe("success");
    expect(await readFile(join(scratch, "out.txt"), "utf8")).toBe("shipped");
    // The loop handler strips the <promise>APPROVED</promise> tag from notes.
    const implOutcome = res.node_outcomes["implement_and_review"]!;
    expect(implOutcome.status).toBe("success");
    expect(implOutcome.notes).not.toContain("<promise>");
    expect(implOutcome.notes).not.toContain("APPROVED");
  });

  test("rejects iteration 1, approves iteration 2 — thread history carries feedback", async () => {
    // Iteration 1: make a change, then DON'T emit APPROVED (reviewer implicitly rejected).
    // Iteration 2: the loop re-prompts us with "continue toward APPROVED"; emit the tag.
    mock.setResponses([
      // Iter 1
      fauxAssistantMessage([fauxToolCall("local__write_file", { path: "out.txt", contents: "v1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("reviewer said: missing test — will fix next turn", { stopReason: "stop" }),
      // Iter 2
      fauxAssistantMessage([fauxToolCall("local__write_file", { path: "out.txt", contents: "v2" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("<promise>APPROVED</promise>", { stopReason: "stop" }),
    ]);

    const res = await execute({
      graph: parseDotSource(LOOP_ONLY_WORKFLOW),
      backend: mock.backend,
    });

    expect(res.outcome.status).toBe("success");
    // Final content reflects iter-2's write
    expect(await readFile(join(scratch, "out.txt"), "utf8")).toBe("v2");
    // Node-level outcome is success (loop completed via the APPROVED tag)
    expect(res.node_outcomes["implement_and_review"]!.status).toBe("success");
    // 2 of 4 scripted responses (the second pair) were consumed
    expect(mock.callCount()).toBe(4);
  });

  test("never approves → fails after max_iterations=3 with a clear reason", async () => {
    // 3 iterations, each emits non-APPROVED text.
    const neverApprove = Array.from({ length: 3 }, () =>
      fauxAssistantMessage("still iterating, not done", { stopReason: "stop" }),
    );
    mock.setResponses(neverApprove);

    const res = await execute({
      graph: parseDotSource(LOOP_ONLY_WORKFLOW),
      backend: mock.backend,
    });

    expect(res.node_outcomes["implement_and_review"]!.status).toBe("fail");
    expect(res.node_outcomes["implement_and_review"]!.failure_reason).toContain("did not emit");
    expect(res.node_outcomes["implement_and_review"]!.failure_reason).toContain("<promise>APPROVED</promise>");
    expect(mock.callCount()).toBe(3);
  });
});

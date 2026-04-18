// Unit tests for the pure fidelity policy + seed builder. Integration
// tests that exercise the full backend path through a real Agent live in
// fidelity-apply.test.ts.

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { buildFidelitySeed, resolveSessionId, shouldHydrateFromStore, shouldPersistToStore } from "../src/fidelity.ts";

function asstMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

describe("shouldHydrateFromStore / shouldPersistToStore", () => {
  test("full hydrates + persists; non-full never does", () => {
    expect(shouldHydrateFromStore("full", false)).toBe(true);
    expect(shouldPersistToStore("full", false)).toBe(true);
    for (const m of ["truncate", "compact", "summary:low", "summary:medium", "summary:high"] as const) {
      expect(shouldHydrateFromStore(m, false)).toBe(false);
      expect(shouldPersistToStore(m, false)).toBe(false);
    }
  });

  test("context=fresh forces no hydrate and no persist even for full", () => {
    expect(shouldHydrateFromStore("full", true)).toBe(false);
    expect(shouldPersistToStore("full", true)).toBe(false);
  });
});

describe("resolveSessionId — cache bucket policy", () => {
  test("full fidelity shares the cache bucket with thread_id", () => {
    expect(resolveSessionId({ fidelity: "full", threadId: "dev", isFresh: false })).toBe("dev");
  });

  test("non-full fidelities get their own namespace under the thread", () => {
    expect(resolveSessionId({ fidelity: "truncate", threadId: "dev", isFresh: false })).toBe("dev:truncate");
    expect(resolveSessionId({ fidelity: "compact", threadId: "dev", isFresh: false })).toBe("dev:compact");
    expect(resolveSessionId({ fidelity: "summary:low", threadId: "dev", isFresh: false })).toBe("dev:summary:low");
    expect(resolveSessionId({ fidelity: "summary:high", threadId: "dev", isFresh: false })).toBe("dev:summary:high");
  });

  test("context=fresh opts out of sessionId altogether", () => {
    expect(resolveSessionId({ fidelity: "full", threadId: "dev", isFresh: true })).toBeUndefined();
  });

  test("no thread_id → no sessionId regardless of fidelity", () => {
    expect(resolveSessionId({ fidelity: "full", threadId: undefined, isFresh: false })).toBeUndefined();
    expect(resolveSessionId({ fidelity: "compact", threadId: undefined, isFresh: false })).toBeUndefined();
  });
});

describe("buildFidelitySeed", () => {
  const baseParams = {
    graphGoal: "ship a feature",
    runId: "run-123",
    priorMessages: [] as AgentMessage[],
  };

  test("full mode produces no seed", () => {
    const { seed, warnings } = buildFidelitySeed({ ...baseParams, fidelity: "full" });
    expect(seed).toBe("");
    expect(warnings).toEqual([]);
  });

  test("truncate seed carries goal + run_id only, no prior conversation", () => {
    const { seed } = buildFidelitySeed({
      ...baseParams,
      fidelity: "truncate",
      priorMessages: [userMsg("hi"), asstMsg("old reply")],
    });
    expect(seed).toContain('fidelity="truncate"');
    expect(seed).toContain("Goal: ship a feature");
    expect(seed).toContain("Run: run-123");
    expect(seed).toContain("No prior conversation");
    // Truncate is intentionally amnesic; prior content must NOT leak.
    expect(seed).not.toContain("old reply");
  });

  test("compact seed includes role census and latest assistant text", () => {
    const { seed } = buildFidelitySeed({
      ...baseParams,
      fidelity: "compact",
      priorMessages: [userMsg("q1"), asstMsg("a1"), userMsg("q2"), asstMsg("final answer")],
    });
    expect(seed).toContain('fidelity="compact"');
    expect(seed).toContain("Prior turns: 4");
    expect(seed).toContain("user=2");
    expect(seed).toContain("assistant=2");
    expect(seed).toContain("final answer");
  });

  test("summary:low is deterministic (no LLM) and tags the mode", () => {
    const a = buildFidelitySeed({ ...baseParams, fidelity: "summary:low", priorMessages: [asstMsg("x")] });
    const b = buildFidelitySeed({ ...baseParams, fidelity: "summary:low", priorMessages: [asstMsg("x")] });
    expect(a.seed).toBe(b.seed);
    expect(a.seed).toContain('fidelity="summary:low"');
    expect(a.warnings).toEqual([]);
  });

  test("summary:medium/high warn and fall back to summary:low behaviour", () => {
    const { seed: med, warnings: medWarn } = buildFidelitySeed({ ...baseParams, fidelity: "summary:medium" });
    expect(med).toContain('fidelity="summary:medium"');
    expect(medWarn.join("\n")).toContain("no summariser backend is wired");
    const { warnings: hiWarn } = buildFidelitySeed({ ...baseParams, fidelity: "summary:high" });
    expect(hiWarn.length).toBe(1);
  });

  test("missing graph goal renders gracefully", () => {
    const { seed } = buildFidelitySeed({ ...baseParams, fidelity: "truncate", graphGoal: undefined });
    expect(seed).toContain("Goal: (unspecified)");
  });
});

// Tests confirming stale `input` fields were removed from api.ts.
//
// 1. CreateRunInput must NOT expose `input?: string` (server dropped routing.input).
// 2. Schedule must use `title` not `input` (store renamed the column).
// 3. isSchedule validator must accept a server payload that has `title`, no `input`.

import { describe, expect, test } from "vitest";
import type { CreateRunInput, Schedule } from "./api.ts";

describe("api.ts stale-input cleanup", () => {
  test("CreateRunInput must NOT expose an `input` field (server dropped routing.input)", () => {
    // If `input` re-appears on CreateRunInput the @ts-expect-error below becomes
    // an "unused directive" TS2578 error, which fails the typecheck gate.
    const args: CreateRunInput = { cwd: "/project", workflowName: "deploy" };
    // @ts-expect-error — `input` must not exist on CreateRunInput
    const _dead: string | undefined = args.input;
    expect(_dead).toBeUndefined();
  });

  test("Schedule type must expose `title` not `input` (store renamed column)", () => {
    const s = {} as Schedule;
    // `title` must be accessible — TS2339 would fire here if the field is absent.
    const _title: string | null = s.title;
    expect(_title === null || typeof _title === "string" || _title === undefined).toBe(true);

    // `input` must no longer exist — @ts-expect-error guards against re-introduction.
    // @ts-expect-error — `input` must not exist on Schedule
    const _dead: string | null | undefined = s.input;
    expect(_dead === null || typeof _dead === "string" || _dead === undefined).toBe(true);
  });

  test("isSchedule validator must accept a server payload with `title` (not `input`)", async () => {
    // The server sends `title: null` instead of `input: null`.
    // Before the fix, isSchedule() checked o["input"], so a payload with
    // `title: null` and no `input` field was rejected as malformed.
    const serverPayload = [
      {
        id: "sched-1",
        workflowRef: "deploy",
        cwd: "/project",
        intervalMs: 60_000,
        intervalText: "every 1m",
        title: null,
        overlapPolicy: "skip",
        nextFireAt: Date.now(),
        lastFireAt: null,
        lastRunId: null,
        pausedAt: null,
        createdAt: Date.now(),
        recentRuns: [],
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(serverPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: () => {} },
    ) as typeof fetch;

    try {
      const { listSchedules } = await import("./api.ts");
      await expect(listSchedules()).resolves.toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

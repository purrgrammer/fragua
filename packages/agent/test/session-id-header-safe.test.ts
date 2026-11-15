import { describe, expect, test } from "bun:test";
import { resolveSessionId, syntheticThreadId } from "../src/thread.ts";

function asHeader(sessionId: string | undefined): string | null {
  if (sessionId === undefined) throw new Error("expected a session id");
  return new Headers({ "x-session-id": sessionId }).get("x-session-id");
}

describe("resolveSessionId is safe to send as an HTTP header value", () => {
  const threadIds = {
    "synthetic per-node thread": syntheticThreadId("read_profile", 0),
    "synthetic thread on a later pass": syntheticThreadId("read_profile", 2, 1),
    "thread name beyond latin-1": "レビュー",
    "thread name with a line break": "dev\nreview",
    "thread name with a space": "dev review",
  };

  for (const [label, threadId] of Object.entries(threadIds)) {
    for (const summary of [undefined, "low"] as const) {
      test(`${label}${summary ? ` + summary=${summary}` : ""}`, () => {
        const sessionId = resolveSessionId({ threadId, summary });
        expect(asHeader(sessionId)).toBe(sessionId as string);
      });
    }
  }

  test("distinct threads keep distinct session ids", () => {
    const ids = ["node:a#0", "\u0000node:a#0", "%0000node:a#0", "a b", "a\u007fb", "ab", "a\nb"].map((threadId) =>
      resolveSessionId({ threadId, summary: undefined }),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a plain thread name is sent unchanged", () => {
    expect(resolveSessionId({ threadId: "dev", summary: undefined })).toBe("dev");
    expect(resolveSessionId({ threadId: "dev", summary: "high" })).toBe("dev:summary-high");
  });

  test("an unthreaded call still has no session id", () => {
    expect(resolveSessionId({ threadId: undefined, summary: undefined })).toBeUndefined();
  });
});

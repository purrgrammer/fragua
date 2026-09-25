// `getApiKey` runs on EVERY LLM invocation, and an expired OAuth credential
// refreshes inline on that path. So a token endpoint that accepts the
// connection and then never answers does not make one node slow — it holds
// every node needing that credential until the process restarts, with nothing
// inside the daemon able to break the wait. The refresh therefore carries its
// own deadline, driven through the provider's own abort signal so the in-flight
// request unwinds instead of being orphaned.

import { describe, expect, test } from "bun:test";
import { refreshWithDeadline } from "../src/credentials/auth-storage.ts";

type Cred = Parameters<Parameters<typeof refreshWithDeadline>[0]["refresh"]>[0];

const cred = { type: "oauth", refresh: "r", access: "a", expires: 0 } as unknown as Cred;

describe("refreshWithDeadline", () => {
  test("a hung refresh is aborted rather than awaited forever", async () => {
    let observed: AbortSignal | undefined;
    const oauth = {
      // Never resolves on its own — only the signal can end this.
      refresh: (_c: Cred, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          observed = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    };

    await expect(refreshWithDeadline(oauth, cred, 20)).rejects.toThrow(/exceeded 20ms/);
    expect(observed?.aborted).toBe(true);
  });

  test("a refresh that answers in time returns its credential untouched", async () => {
    const refreshed = { ...cred, access: "fresh" };
    const oauth = { refresh: async () => refreshed as Cred };

    await expect(refreshWithDeadline(oauth, cred, 5_000)).resolves.toBe(refreshed);
  });

  test("the deadline does not fire after a refresh already returned", async () => {
    // A timer left armed past the call would abort a signal nobody is reading
    // and, in a long-lived daemon, keep the loop alive for nothing.
    let signal: AbortSignal | undefined;
    const oauth = {
      refresh: async (_c: Cred, s: AbortSignal) => {
        signal = s;
        return cred;
      },
    };

    await refreshWithDeadline(oauth, cred, 10);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal?.aborted).toBe(false);
  });
});

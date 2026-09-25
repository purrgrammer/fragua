// Regression probe for the OAuth authorize-URL build after the pi-ai
// auth-layer migration (0.87.1). pi-ai moved OAuth off a global registry
// onto `Provider.auth.oauth`; if that flow builds a malformed authorize URL
// nobody can log in (GitHub issue #74). We drive the anthropic provider's
// login with an interaction that records the URL via `notify` and then throws
// from `prompt` to unwind before any callback server work — nothing is
// persisted, no browser opens.

import { describe, expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

describe("Anthropic OAuth login (pi-ai 0.87.1)", () => {
  test("the authorize URL it emits carries code_challenge_method=S256", async () => {
    const anthropic = builtinProviders().find((p) => p.id === "anthropic");
    expect(anthropic?.auth.oauth).toBeDefined();
    const oauth = anthropic!.auth.oauth!;

    const controller = new AbortController();
    let authUrl: string | undefined;
    const interaction = {
      signal: controller.signal,
      notify: (event: { type: string; url?: string }) => {
        if (event.type === "auth_url" && typeof event.url === "string") authUrl = event.url;
      },
      prompt: async () => {
        throw new Error("unwind");
      },
    };

    try {
      await oauth.login(interaction);
    } catch {
      // Expected: `prompt` throws to unwind the flow once the URL is captured.
    } finally {
      controller.abort();
    }

    expect(authUrl).toBeDefined();
    expect(new URL(authUrl!).searchParams.get("code_challenge_method")).toBe("S256");
  });
});

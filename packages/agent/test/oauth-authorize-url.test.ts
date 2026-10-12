// Regression probe for the OAuth authorize-URL build. pi-ai keeps OAuth on
// `Provider.auth.oauth`; if that flow builds a malformed authorize URL nobody
// can log in (GitHub issue #74). We drive the anthropic provider's login with
// an interaction that answers the login-method selector with the headless
// copy-code method (no browser, no callback server), records the URL via
// `notify`, and then throws from the code prompt to unwind — nothing is
// persisted.

import { describe, expect, test } from "bun:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

describe("Anthropic OAuth login", () => {
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
      prompt: async (p: { type: string }) => {
        if (p.type === "select") return "copy_code";
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

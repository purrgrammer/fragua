// The pi-ai-backed implementation of @fragua/server's `ProviderTester`
// seam. Lives in the CLI assembly (which legitimately depends on pi-ai)
// so the server package carries no pi-ai runtime dependency; the server
// route injects this via `ServerOptions.testProvider`.

import { streamSimple } from "@earendil-works/pi-ai";
import type { ProviderTester } from "@fragua/server";

export const streamSimpleProviderTester: ProviderTester = async (model, apiKey) => {
  const started = Date.now();
  let firstDeltaMs: number | undefined;
  let outputTokens = 0;
  try {
    const stream = streamSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
      // biome-ignore lint/suspicious/noExplicitAny: pi-ai StreamOptions is an opaque provider-specific bag.
      { maxTokens: 1, apiKey } as any,
    );
    for await (const ev of stream) {
      if (ev.type === "text_delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - started;
      if (ev.type === "done") outputTokens = ev.message.usage?.output ?? 0;
      if (ev.type === "error") {
        return { ok: false, error: ev.error.errorMessage ?? "unknown provider error" };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, firstDeltaMs: firstDeltaMs ?? null, totalMs: Date.now() - started, outputTokens };
};

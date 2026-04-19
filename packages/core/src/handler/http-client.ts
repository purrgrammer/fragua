import type { HttpClient } from "./types.ts";

export interface HttpClientOpts {
  signal: AbortSignal;
  defaultTimeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Thin fetch wrapper that pre-wires the executor-provided AbortSignal onto
 * every request. Handlers get an HttpClient instance and may not call the
 * global fetch directly (enforced by structural lint).
 */
export function makeHttpClient(opts: HttpClientOpts): HttpClient {
  const impl = opts.fetch ?? fetch;
  return {
    async fetch(input, init = {}) {
      const signals: AbortSignal[] = [opts.signal];
      if (init.signal) signals.push(init.signal);
      if (opts.defaultTimeoutMs != null) {
        signals.push(AbortSignal.timeout(opts.defaultTimeoutMs));
      }
      const signal =
        signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
      return impl(input, { ...init, signal });
    },
  };
}

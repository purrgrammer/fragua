// PiMockBackend — full agent loop against pi-ai's faux provider. Use this in
// tests to exercise the real Agent + tool path without real API calls.

import { type FauxResponseStep, fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import type { SummariserBackend } from "@fragua/core";
import type { Skill } from "@fragua/types";
import type { ExecutionEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "./backend.ts";

export interface PiMockBackendOptions {
  registry: ToolRegistry;
  env: ExecutionEnvironment;
  /** Pre-scripted assistant messages. Each element = one LLM call. */
  responses?: FauxResponseStep[];
  systemPrompt?: string;
  /** Inject a summariser stub so integration tests can exercise the
   * summary:medium/high path without live pi-ai calls. */
  summariser?: SummariserBackend;
  /** Discovery superset the backend filters per run. Needed by tests that
   * assert on the rendered skills catalogue — without it the catalogue is
   * empty and the skills path is never exercised. */
  skills?: Skill[];
}

export interface PiMockBackendHandle {
  backend: PiLlmBackend;
  /** Replace the queued responses. */
  setResponses(responses: FauxResponseStep[]): void;
  /** Append responses to the queue. */
  appendResponses(responses: FauxResponseStep[]): void;
  /** Unregister the faux provider (tests should call this in afterEach). */
  dispose(): void;
  /** Count of LLM calls received so far. */
  callCount(): number;
}

export function createPiMockBackend(opts: PiMockBackendOptions): PiMockBackendHandle {
  const registration = registerFauxProvider();
  if (opts.responses) registration.setResponses(opts.responses);

  const model = registration.getModel();
  const backend = new PiLlmBackend({
    registry: opts.registry,
    env: opts.env,
    resolveModel: () => model,
    defaultModel: { provider: model.provider, model: model.id },
    ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.summariser !== undefined ? { summariser: opts.summariser } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
  });

  return {
    backend,
    setResponses: (r) => registration.setResponses(r),
    appendResponses: (r) => registration.appendResponses(r),
    callCount: () => registration.state.callCount,
    dispose: () => registration.unregister(),
  };
}

export { fauxAssistantMessage };
export { fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";

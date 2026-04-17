// Ports for @swarm/server. Route handlers depend on these interfaces; adapters
// (filesystem, WASM Graphviz, in-memory interviewer) live in ./adapters/ and
// plug in via `createServer`. Tests swap in fakes to keep assertions fast and
// free of I/O. This mirrors the pattern used by @swarm/core.

import type { Event, EventSink } from "@swarm/core";

/**
 * Reader for the run archive. The server never touches `node:fs` directly —
 * all on-disk shape concerns live in the adapter.
 */
export interface RunReader {
  /** Enumerate all run ids (usually directory names under `.swarm/runs/`). */
  listRuns(): Promise<string[]>;
  /**
   * Load every event for a run in the order they were written. Returns
   * `undefined` when the run does not exist so handlers can respond with 404
   * rather than distinguishing "missing" from "empty".
   */
  readEvents(runId: string): Promise<Event[] | undefined>;
}

/** Render a Graphviz DOT source string to a standalone SVG document. */
export interface GraphRenderer {
  /** Resolves to a full `<svg …>…</svg>` string. Must not throw synchronously. */
  render(dotSource: string): Promise<string>;
}

/** A pending question tagged with its originating run for routing. */
export interface PendingQuestion {
  runId: string;
  questionId: string;
  nodeId: string;
  text: string;
  type: "YES_NO" | "MULTIPLE_CHOICE" | "FREEFORM" | "CONFIRMATION";
  options?: Array<{ key: string; label: string }>;
  stage: string;
  askedAt: string;
}

export type InterviewAnswerResult =
  | { ok: true }
  | { ok: false; code: "unknown_question" | "already_answered" | "invalid_answer"; message: string };

/**
 * Gateway for the web interview channel. Decouples the REST surface from the
 * concrete `Interviewer` implementation (see task 03). In P5.02 the default
 * adapter derives pending questions from the event stream and delegates
 * answer dispatch to an injected `EventSink`.
 */
export interface InterviewGateway {
  /** Pending (unanswered) questions for a run, in ask order. */
  pending(runId: string): Promise<PendingQuestion[]>;
  /** Submit an answer. Emits `interview.completed` on the EventSink when ok. */
  answer(runId: string, questionId: string, answer: { value: string; text?: string }): Promise<InterviewAnswerResult>;
}

/** Bundle of ports passed to `createServer`. All optional; defaults below. */
export interface ServerPorts {
  runReader?: RunReader;
  graphRenderer?: GraphRenderer;
  interviewGateway?: InterviewGateway;
  /** Optional sink for interview.* events emitted on answer. */
  eventSink?: EventSink;
}

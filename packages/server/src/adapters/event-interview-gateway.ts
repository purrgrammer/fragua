// Default InterviewGateway that derives pending questions from the event
// stream. The source of truth is the run's `events.jsonl`:
//
//   * `interview.started`   → a new pending question (data.question payload)
//   * `interview.completed` → the matching question is answered
//   * `interview.timeout`   → also removes it from "pending"
//
// On answer, we emit an `interview.completed` event on the injected EventSink.
// A future task (P5.03, WebInterviewer) will subscribe to that sink to
// resolve the in-process Question promise, but the REST surface is agnostic
// to that: it only cares that the *event log* reflects the answer.

import type { Event, EventSink } from "@swarm/core";
import type { InterviewAnswerResult, InterviewGateway, PendingQuestion, RunReader } from "../ports.ts";

export interface EventInterviewGatewayOptions {
  runReader: RunReader;
  /**
   * Optional sink for the `interview.completed` event emitted when an answer
   * lands. If absent, answers are accepted (returns `{ ok: true }`) but no
   * downstream event is recorded — useful for read-only deployments.
   */
  eventSink?: EventSink;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

interface StartedQuestionPayload {
  question_id?: string;
  text?: string;
  type?: PendingQuestion["type"];
  options?: PendingQuestion["options"];
  stage?: string;
}

export function createEventInterviewGateway(opts: EventInterviewGatewayOptions): InterviewGateway {
  const { runReader, eventSink, now = () => new Date() } = opts;

  async function collectPending(runId: string): Promise<PendingQuestion[] | undefined> {
    const events = await runReader.readEvents(runId);
    if (!events) return undefined;

    const pendingById = new Map<string, PendingQuestion>();
    for (const ev of events) {
      if (ev.type === "interview.started") {
        const q = ev.data as StartedQuestionPayload;
        const questionId = q.question_id;
        if (!questionId) continue;
        // exactOptionalPropertyTypes: only include `options` if defined.
        const base: PendingQuestion = {
          runId,
          questionId,
          nodeId: ev.node_id ?? "",
          text: q.text ?? "",
          type: q.type ?? "FREEFORM",
          stage: q.stage ?? "",
          askedAt: ev.timestamp,
        };
        if (q.options !== undefined) base.options = q.options;
        pendingById.set(questionId, base);
      } else if (ev.type === "interview.completed" || ev.type === "interview.timeout") {
        const q = ev.data as { question_id?: string };
        if (q.question_id) pendingById.delete(q.question_id);
      }
    }
    return [...pendingById.values()];
  }

  return {
    async pending(runId: string): Promise<PendingQuestion[]> {
      const out = await collectPending(runId);
      return out ?? [];
    },

    async answer(runId, questionId, answer): Promise<InterviewAnswerResult> {
      const events = await runReader.readEvents(runId);
      if (!events) {
        return { ok: false, code: "unknown_question", message: `run not found: ${runId}` };
      }

      // Find the originating started event; also detect duplicate answers.
      let started: Event | undefined;
      let alreadyAnswered = false;
      for (const ev of events) {
        const qid = (ev.data as { question_id?: string }).question_id;
        if (qid !== questionId) continue;
        if (ev.type === "interview.started") started = ev;
        else if (ev.type === "interview.completed" || ev.type === "interview.timeout") {
          alreadyAnswered = true;
        }
      }
      if (!started) {
        return { ok: false, code: "unknown_question", message: `unknown question: ${questionId}` };
      }
      if (alreadyAnswered) {
        return { ok: false, code: "already_answered", message: `already answered: ${questionId}` };
      }

      if (eventSink) {
        const completion: Event = {
          run_id: runId,
          type: "interview.completed",
          timestamp: now().toISOString(),
          workflow_sha: started.workflow_sha,
          data: {
            question_id: questionId,
            value: answer.value,
            ...(answer.text !== undefined ? { text: answer.text } : {}),
            source: "web",
          },
        };
        // exactOptionalPropertyTypes: only attach node_id if defined.
        if (started.node_id !== undefined) completion.node_id = started.node_id;
        await eventSink.append(completion);
      }
      return { ok: true };
    },
  };
}

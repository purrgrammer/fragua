// Three built-in Interviewer implementations. See docs/SPEC.md §3.9.

import type { Answer, Interviewer, Question } from "../types/interviewer.ts";

/** Always answers "yes" / first option / confirms. Default for CI runs. */
export class AutoApproveInterviewer implements Interviewer {
  async ask(question: Question): Promise<Answer> {
    if (question.type === "YES_NO" || question.type === "CONFIRMATION") return { value: "YES" };
    if (question.type === "MULTIPLE_CHOICE") {
      const first = question.options?.[0];
      return first ? { value: first.key, selected_option: first } : { value: "YES" };
    }
    return { value: "", text: "" };
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    return Promise.all(questions.map((q) => this.ask(q)));
  }

  inform(_message: string, _stage: string): void {
    // no-op
  }
}

/** Pre-fills the answer queue for deterministic replay / tests. */
export class QueueInterviewer implements Interviewer {
  private readonly queue: Answer[];
  readonly informed: Array<{ message: string; stage: string }> = [];

  constructor(answers: Answer[] = []) {
    this.queue = [...answers];
  }

  enqueue(...answers: Answer[]): void {
    this.queue.push(...answers);
  }

  get remaining(): number {
    return this.queue.length;
  }

  async ask(_question: Question): Promise<Answer> {
    const next = this.queue.shift();
    if (!next) throw new Error("QueueInterviewer: no more answers queued");
    return next;
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    const out: Answer[] = [];
    for (const q of questions) out.push(await this.ask(q));
    return out;
  }

  inform(message: string, stage: string): void {
    this.informed.push({ message, stage });
  }
}

export interface InterviewRecord {
  question: Question;
  answer: Answer;
  timestamp: string;
}

/** Wraps another Interviewer and records every exchange. Useful for audit + replay. */
export class RecordingInterviewer implements Interviewer {
  readonly records: InterviewRecord[] = [];
  readonly informed: Array<{ message: string; stage: string; timestamp: string }> = [];

  constructor(
    private readonly inner: Interviewer,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async ask(question: Question): Promise<Answer> {
    const answer = await this.inner.ask(question);
    this.records.push({ question, answer, timestamp: this.now() });
    return answer;
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    const answers = await this.inner.ask_multiple(questions);
    for (let i = 0; i < questions.length; i++) {
      this.records.push({
        question: questions[i]!,
        answer: answers[i]!,
        timestamp: this.now(),
      });
    }
    return answers;
  }

  inform(message: string, stage: string): void {
    this.informed.push({ message, stage, timestamp: this.now() });
    this.inner.inform(message, stage);
  }
}

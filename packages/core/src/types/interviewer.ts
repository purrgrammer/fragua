// Interviewer: the single human-in-the-loop interface. See docs/SPEC.md §3.9.

export type QuestionType = "YES_NO" | "MULTIPLE_CHOICE" | "FREEFORM" | "CONFIRMATION";

export type AnswerValue = "YES" | "NO" | "SKIPPED" | "TIMEOUT";

export interface Option {
  /** Single-character accelerator, e.g. "Y", "A". */
  key: string;
  label: string;
}

export interface Question {
  text: string;
  type: QuestionType;
  options?: Option[];
  default?: string | AnswerValue;
  timeout_seconds?: number;
  stage: string;
  metadata: Record<string, unknown>;
}

export interface Answer {
  value: string | AnswerValue;
  selected_option?: Option;
  text?: string;
}

export interface Interviewer {
  ask(question: Question): Promise<Answer>;
  ask_multiple(questions: Question[]): Promise<Answer[]>;
  inform(message: string, stage: string): void;
}

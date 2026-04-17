// ConsoleInterviewer — interactive approval / steering via stdin.
// Kept in @swarm/core so the orchestrator itself has a complete HITL story
// without depending on I/O packages.

import type { Answer, Interviewer, Question } from "../types/interviewer.ts";

type Writer = (line: string) => void;
type Reader = () => Promise<string>;

export interface ConsoleInterviewerOptions {
  /** Output sink. Default stderr so stdout stays parseable. */
  writer?: Writer;
  /** Input source. Default reads a single line from stdin. */
  reader?: Reader;
  /** Default timeout applied when the Question has no explicit one. */
  defaultTimeoutSeconds?: number;
}

export class ConsoleInterviewer implements Interviewer {
  private readonly write: Writer;
  private readonly read: Reader;
  private readonly defaultTimeout: number | undefined;

  constructor(opts: ConsoleInterviewerOptions = {}) {
    this.write = opts.writer ?? ((line: string) => process.stderr.write(line));
    this.read = opts.reader ?? defaultStdinLineReader;
    this.defaultTimeout = opts.defaultTimeoutSeconds;
  }

  async ask(question: Question): Promise<Answer> {
    this.write(`\n━━ ${question.stage || "human"} ━━\n`);
    this.write(`${question.text}\n`);

    const opts = question.options ?? [];
    switch (question.type) {
      case "YES_NO":
      case "CONFIRMATION":
        this.write(`[y/N] `);
        break;
      case "MULTIPLE_CHOICE":
        for (const o of opts) this.write(`  [${o.key}] ${o.label}\n`);
        this.write(`Select: `);
        break;
      case "FREEFORM":
        this.write(`> `);
        break;
    }

    const timeoutSec = question.timeout_seconds ?? this.defaultTimeout;
    const input = await this.readWithTimeout(timeoutSec);
    if (input === TIMEOUT) {
      this.write(`\n[timeout — using default]\n`);
      if (question.default !== undefined) {
        return { value: question.default };
      }
      return { value: "TIMEOUT" };
    }

    const trimmed = input.trim();
    switch (question.type) {
      case "YES_NO":
      case "CONFIRMATION": {
        const v = trimmed.toLowerCase();
        if (v === "y" || v === "yes") return { value: "YES" };
        return { value: "NO" };
      }
      case "MULTIPLE_CHOICE": {
        const hit = opts.find(
          (o) => o.key.toLowerCase() === trimmed.toLowerCase() || o.label.toLowerCase() === trimmed.toLowerCase(),
        );
        if (hit) return { value: hit.key, selected_option: hit };
        return { value: trimmed || "SKIPPED", text: trimmed };
      }
      case "FREEFORM":
        return { value: trimmed, text: trimmed };
    }
  }

  async ask_multiple(questions: Question[]): Promise<Answer[]> {
    const out: Answer[] = [];
    for (const q of questions) out.push(await this.ask(q));
    return out;
  }

  inform(message: string, stage: string): void {
    this.write(`\n[${stage}] ${message}\n`);
  }

  private async readWithTimeout(seconds: number | undefined): Promise<string | typeof TIMEOUT> {
    if (seconds === undefined || seconds <= 0) return this.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), seconds * 1000);
    });
    try {
      return await Promise.race([this.read(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const TIMEOUT = Symbol("TIMEOUT");

function defaultStdinLineReader(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stdin.off("data", onData);
        if (typeof stdin.pause === "function") stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    if (typeof stdin.resume === "function") stdin.resume();
    stdin.on("data", onData);
  });
}

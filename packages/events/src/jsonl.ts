// Append-only JSONL event sink. One JSON object per line, flushed on append.
// For production workloads we'd want a WriteStream with backpressure; for
// Phase 2 the simple append model is sufficient.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Event, EventSink } from "@swarm/core";

export interface JsonlSinkOptions {
  /** Absolute path to the output file (created if missing). */
  filePath: string;
}

export class JsonlSink implements EventSink {
  private readonly filePath: string;
  private readonly queue: Event[] = [];
  private flushing: Promise<void> | undefined;
  private initialized = false;

  constructor(opts: JsonlSinkOptions) {
    this.filePath = opts.filePath;
  }

  async append(event: Event): Promise<void> {
    this.queue.push(event);
    if (!this.flushing) this.flushing = this.flush();
    await this.flushing;
  }

  async close(): Promise<void> {
    if (this.flushing) await this.flushing;
  }

  private async flush(): Promise<void> {
    try {
      if (!this.initialized) {
        await mkdir(dirname(this.filePath), { recursive: true });
        this.initialized = true;
      }
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length);
        const payload = `${batch.map((e) => JSON.stringify(e)).join("\n")}\n`;
        await appendFile(this.filePath, payload, "utf8");
      }
    } finally {
      this.flushing = undefined;
    }
  }
}

/** Parse a JSONL file back into an array of events (one-shot, for replay). */
export async function readJsonlEvents(filePath: string): Promise<Event[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as Event);
}

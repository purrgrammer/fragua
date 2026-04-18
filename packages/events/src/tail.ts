// Async iterator that yields parsed JSONL records from a file: first the
// existing content, then every new line appended after we opened it.
//
// The generic core — `tailJsonlLines<T>` — handles the file I/O, fs.watch
// wake-ups, truncation detection, and partial-line buffering. Callers
// supply a `parse` function that either returns `T` (kept) or `undefined`
// (skip). `tailJsonl` is the Event-shaped wrapper kept for existing
// consumers (server SSE tail, replay tests).
//
// Lives in @swarm/events (not @swarm/server) because JSONL tailing is this
// package's job. The server consumes this as a pure producer; cancellation
// is driven by an AbortSignal so the caller can unwind cleanly.
//
// Implementation notes:
//   - We hold a byte offset into the file and re-read from that offset on
//     every `change` fs.watch event. This is robust to editors that rename
//     (tests just `appendFile`, which is a plain write).
//   - Partial trailing lines are buffered until a newline arrives.
//   - We use fs.watch (not polling). On platforms where watch is flaky
//     (some network filesystems) callers should fall back to readJsonlEvents.
//   - ENOENT mid-tail is swallowed: if the file is removed after we started
//     watching (e.g. tests cleaning up, or a race with the caller) we simply
//     stop yielding. The caller unwinds via AbortSignal in the normal case.

import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Event } from "@swarm/core";

export interface TailJsonlOptions {
  /** Abort to stop the iterator and close the underlying watcher. */
  signal?: AbortSignal;
  /**
   * If true, yield existing file contents before watching for appends.
   * Defaults to true.
   */
  includeExisting?: boolean;
}

export interface TailJsonlLinesOptions<T> extends TailJsonlOptions {
  /** Parse one JSONL line into a record of type T, or return `undefined`
   * to skip (e.g. schema mismatch, transient partial flush). Thrown errors
   * are also swallowed to keep the long-running stream alive. */
  parse: (line: string) => T | undefined;
}

/**
 * Generic JSONL tail. Yields one `T` per line that `parse` accepts.
 * Same file-watching and truncation semantics as `tailJsonl`.
 */
export async function* tailJsonlLines<T>(
  filePath: string,
  opts: TailJsonlLinesOptions<T>,
): AsyncGenerator<T, void, void> {
  const { signal, includeExisting = true, parse } = opts;
  let offset = 0;
  let buffer = "";

  // We coordinate watcher wake-ups via a promise that resolves whenever
  // fs.watch fires OR the signal aborts. Producers push, consumer pulls.
  let wake: (() => void) | undefined;
  const waitForChange = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });

  const wakeNow = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };

  let watcher: FSWatcher | undefined;
  const onAbort = () => {
    watcher?.close();
    wakeNow();
  };
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // Read whatever exists, from byte 0.
    if (includeExisting) {
      const existing = await readFrom(filePath, 0);
      offset = existing.offset;
      buffer += existing.chunk;
      const drained = splitBuffer(buffer, parse);
      for (const rec of drained.records) yield rec;
      buffer = drained.remainder;
    } else {
      // Start at current EOF so we only see new appends.
      try {
        const s = await stat(filePath);
        offset = s.size;
      } catch {
        offset = 0;
      }
    }

    // fs.watch may fire before the file exists — watch the file directly;
    // if it doesn't exist yet the caller should create it before tailing.
    try {
      watcher = watch(filePath, { persistent: false }, () => wakeNow());
    } catch {
      // File vanished between the initial read and now. Nothing to tail.
      return;
    }

    while (!signal?.aborted) {
      await waitForChange();
      if (signal?.aborted) break;
      const { chunk, offset: next, gone } = await readFrom(filePath, offset);
      if (gone) return;
      if (chunk.length === 0) continue;
      offset = next;
      buffer += chunk;
      const drained = splitBuffer(buffer, parse);
      for (const rec of drained.records) yield rec;
      buffer = drained.remainder;
    }
  } finally {
    watcher?.close();
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Tail a JSONL event file. Yields one `Event` per line. Resolves when the
 * signal aborts. Non-JSON / blank lines are skipped silently (defensive:
 * a partially-flushed writer should never kill a long-running stream).
 */
export function tailJsonl(filePath: string, opts: TailJsonlOptions = {}): AsyncGenerator<Event, void, void> {
  return tailJsonlLines<Event>(filePath, { ...opts, parse: parseEventLine });
}

function parseEventLine(line: string): Event | undefined {
  try {
    return JSON.parse(line) as Event;
  } catch {
    return undefined;
  }
}

interface ReadResult {
  chunk: string;
  offset: number;
  /** True if the file has been removed; caller should stop tailing. */
  gone?: boolean;
}

async function readFrom(filePath: string, fromOffset: number): Promise<ReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      return { chunk: "", offset: fromOffset, gone: true };
    }
    throw err;
  }
  try {
    const s = await handle.stat();
    // File shrank → likely truncated or rotated; reset to 0 so we replay the new content.
    const startAt = s.size < fromOffset ? 0 : fromOffset;
    if (s.size <= startAt) return { chunk: "", offset: startAt };
    const length = s.size - startAt;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, startAt);
    return { chunk: buf.toString("utf8"), offset: s.size };
  } finally {
    await handle.close();
  }
}

/** Split `buffer` into parsed records (all complete `\n`-terminated lines,
 * as filtered by `parse`) and the remainder (text after the last newline).
 * Malformed / unparseable lines are skipped. */
function splitBuffer<T>(buffer: string, parse: (line: string) => T | undefined): { records: T[]; remainder: string } {
  const lastNl = buffer.lastIndexOf("\n");
  if (lastNl < 0) return { records: [], remainder: buffer };
  const records: T[] = [];
  for (const raw of buffer.slice(0, lastNl).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: T | undefined;
    try {
      parsed = parse(line);
    } catch {
      // writer may be mid-flush, or line may not fit the schema; skip
      continue;
    }
    if (parsed !== undefined) records.push(parsed);
  }
  return { records, remainder: buffer.slice(lastNl + 1) };
}

// Filesystem RunReader: reads `<runsDir>/<runId>/events.jsonl` via
// `@swarm/events:readJsonlEvents` so we inherit its lenient JSONL parsing.
//
// This adapter is the *only* place in @swarm/server (outside route wiring)
// that touches `node:fs`. Handlers stay pure so property tests work.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { readJsonlEvents } from "@swarm/events";
import type { RunReader } from "../ports.ts";

export interface FsRunReaderOptions {
  /** Directory containing `<runId>/events.jsonl`. */
  runsDir: string;
}

export function createFsRunReader(opts: FsRunReaderOptions): RunReader {
  const { runsDir } = opts;

  return {
    async listRuns(): Promise<string[]> {
      let entries: string[];
      try {
        entries = await readdir(runsDir);
      } catch {
        // Missing directory is equivalent to "no runs" — the caller surfaces
        // an empty list, never a 5xx. Matches `swarm list` semantics.
        return [];
      }
      const out: string[] = [];
      for (const id of entries) {
        try {
          const st = await stat(join(runsDir, id));
          if (st.isDirectory()) out.push(id);
        } catch {
          // Race with concurrent cleanup — skip silently.
        }
      }
      return out;
    },

    async readEvents(runId: string): Promise<Event[] | undefined> {
      const file = join(runsDir, runId, "events.jsonl");
      try {
        return await readJsonlEvents(file);
      } catch (err) {
        // ENOENT → undefined (handler emits 404). Anything else bubbles so
        // operators see genuine failures rather than silent 404s.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw err;
      }
    },
  };
}

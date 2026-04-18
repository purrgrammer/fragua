// Writer + reader for `.swarm/runs/<runId>/control.jsonl`, the sibling
// control channel that replaced the legacy `steering.jsonl` sidecar.
//
// The file is append-only JSONL where each line is a `ControlRequest`
// (shape defined in @swarm/core). Producers are the CLI (`swarm steer`,
// `swarm pause`, `swarm resume`, `swarm cancel`) and later the daemon;
// the only consumer is the executor, which tails this file, mirrors each
// request into the run's `events.jsonl` as a `control.requested` event,
// applies it at the appropriate safe boundary, and emits a paired
// `control.applied` or `control.rejected`.
//
// We deliberately do NOT promote `ControlRequest` to a full Event
// envelope at the file layer — producers shouldn't need to know
// `workflow_sha`, `schema_version`, or the runtime's clock. The
// executor adds those when mirroring. Keeping the wire shape small also
// means a future daemon can synthesise requests without round-tripping
// through the runtime just to fill in envelope fields.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ControlCommand, ControlRequest, ControlRequestPayload } from "@swarm/core";
import { type TailJsonlOptions, tailJsonlLines } from "./tail.ts";

/**
 * Append a `ControlRequest` to the given `control.jsonl` path. Creates
 * the parent directory if missing — callers pass the canonical path
 * (`<runsDir>/<runId>/control.jsonl`) and don't need to pre-create.
 *
 * The write is a single `appendFile` — atomic at the OS-level line
 * boundary on POSIX filesystems for <= PIPE_BUF bytes. Our lines are
 * well under that (a few hundred bytes at most), so concurrent writers
 * cannot interleave a single record; the tail reader's line-boundary
 * splitting then guarantees we never yield a torn request.
 */
export async function writeControlRequest(
  filePath: string,
  request: ControlRequest,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(request)}\n`, "utf8");
}

/** Convenience: build a `ControlRequest` with a fresh uuid + ISO timestamp
 * and append it. Returns the materialised request so callers can log / echo
 * the assigned id. */
export async function submitControlRequest(
  filePath: string,
  command: ControlCommand,
  payload?: ControlRequestPayload,
): Promise<ControlRequest> {
  const request: ControlRequest = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    command,
    ...(payload !== undefined ? { payload } : {}),
  };
  await writeControlRequest(filePath, request);
  return request;
}

/** Tail a `control.jsonl` file, yielding one `ControlRequest` per valid
 * line. Shares fs.watch, truncation, and abort semantics with
 * `tailJsonl`. Malformed lines or records missing required fields
 * (`id`, `command`) are skipped silently — the executor should never
 * die on a garbled request. */
export function tailControlRequests(
  filePath: string,
  opts: TailJsonlOptions = {},
): AsyncGenerator<ControlRequest, void, void> {
  return tailJsonlLines<ControlRequest>(filePath, { ...opts, parse: parseControlLine });
}

const KNOWN_COMMANDS: ReadonlySet<ControlCommand> = new Set(["steer", "pause", "resume", "cancel"]);

function parseControlLine(line: string): ControlRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<ControlRequest>;
  if (typeof r.id !== "string" || r.id.length === 0) return undefined;
  if (typeof r.timestamp !== "string" || r.timestamp.length === 0) return undefined;
  if (typeof r.command !== "string" || !KNOWN_COMMANDS.has(r.command as ControlCommand)) return undefined;
  const payload = r.payload && typeof r.payload === "object" ? (r.payload as ControlRequestPayload) : undefined;
  return {
    id: r.id,
    timestamp: r.timestamp,
    command: r.command as ControlCommand,
    ...(payload !== undefined ? { payload } : {}),
  };
}

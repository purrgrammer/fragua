// Rendezvous file for the swarm daemon.
//
// A single running daemon publishes its pid + bound port to
// `.swarm/daemon/daemon.json` so CLI clients can discover it without
// guessing ports or relying on a well-known one. The file is written
// atomically (write temp → rename) so readers never see partial JSON.
//
// This module is intentionally stateless: it owns the file shape, the
// paths, and the helpers for detecting whether a pid is still alive.
// Lifecycle (who starts/stops the daemon, when to unlink the file) is
// the CLI's problem — see `packages/cli/src/commands/daemon.ts`.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const DaemonRendezvous = Type.Object({
  pid: Type.Integer(),
  port: Type.Integer(),
  startedAt: Type.String(),
  version: Type.String(),
});
export type DaemonRendezvousT = Static<typeof DaemonRendezvous>;

/** Absolute path of `.swarm/daemon/` for the given project root. */
export function getDaemonDir(cwd: string): string {
  return resolve(cwd, ".swarm/daemon");
}

/** Absolute path of `.swarm/daemon/daemon.json` for the given project root. */
export function getRendezvousPath(cwd: string): string {
  return join(getDaemonDir(cwd), "daemon.json");
}

/**
 * Write the rendezvous atomically. Creates `.swarm/daemon/` if needed.
 * A crash mid-write leaves either the old file or nothing — never a
 * half-written file — because `rename` is atomic on POSIX.
 */
export async function writeRendezvous(cwd: string, payload: DaemonRendezvousT): Promise<void> {
  const path = getRendezvousPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * Read and validate the rendezvous. Returns `undefined` if the file is
 * absent or its shape doesn't match — callers treat both as "no daemon".
 */
export async function readRendezvous(cwd: string): Promise<DaemonRendezvousT | undefined> {
  const path = getRendezvousPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Value.Check(DaemonRendezvous, parsed)) return undefined;
  return parsed;
}

/** Remove the rendezvous file. ENOENT is silently ignored. */
export async function removeRendezvous(cwd: string): Promise<void> {
  try {
    await unlink(getRendezvousPath(cwd));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Liveness probe. Sends signal 0 — the kernel checks the pid without
 * delivering anything. ESRCH → not alive. EPERM → alive but not owned
 * by us (rare for a local daemon; we still report "alive" so we don't
 * treat a foreign process as stale).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

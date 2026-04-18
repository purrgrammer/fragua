// Filesystem-backed ControlGateway. Translates each REST call into a
// `ControlRequest` line appended to `<runsDir>/<runId>/control.jsonl`.
// The running executor's control loop tails that file and takes it
// from there — the server never touches events.jsonl itself.
//
// Run existence is checked via the injected `RunReader` so the gateway
// returns a uniform `not_found` for any runId that isn't in the
// archive; route handlers turn that into HTTP 404 without duplicating
// the existence check.

import { join } from "node:path";
import { submitControlRequest } from "@swarm/events";
import type { ControlGateway, ControlSubmitResult, RunReader } from "../ports.ts";

export interface FsControlGatewayOptions {
  /** Directory containing per-run subdirectories with `control.jsonl`.
   * Usually `.swarm/runs/` from the project root. */
  runsDir: string;
  /** Used for the run-exists check. The gateway itself never reads
   * events, but refusing unknown runs at the REST boundary matters
   * more than the slight race window with a just-started run. */
  runReader: RunReader;
}

export function createFsControlGateway(opts: FsControlGatewayOptions): ControlGateway {
  const { runsDir, runReader } = opts;

  const pathFor = (runId: string): string => join(runsDir, runId, "control.jsonl");

  const checkRun = async (runId: string): Promise<ControlSubmitResult | undefined> => {
    const events = await runReader.readEvents(runId);
    if (events === undefined) return { ok: false, code: "not_found" };
    return undefined;
  };

  return {
    async steer(runId, message) {
      const miss = await checkRun(runId);
      if (miss) return miss;
      const req = await submitControlRequest(pathFor(runId), "steer", { message });
      return { ok: true, id: req.id };
    },
    async pause(runId, reason) {
      const miss = await checkRun(runId);
      if (miss) return miss;
      const payload = reason !== undefined ? { reason } : undefined;
      const req = await submitControlRequest(pathFor(runId), "pause", payload);
      return { ok: true, id: req.id };
    },
    async resume(runId) {
      const miss = await checkRun(runId);
      if (miss) return miss;
      const req = await submitControlRequest(pathFor(runId), "resume");
      return { ok: true, id: req.id };
    },
    async cancel(runId, reason) {
      const miss = await checkRun(runId);
      if (miss) return miss;
      const payload = reason !== undefined ? { reason } : undefined;
      const req = await submitControlRequest(pathFor(runId), "cancel", payload);
      return { ok: true, id: req.id };
    },
  };
}

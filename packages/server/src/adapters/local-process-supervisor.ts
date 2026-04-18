// Default `ProcessSupervisor` for the local daemon: spawns `swarm run`
// as a child process per job. The child writes its own events.jsonl
// (via the existing in-process executor), so the supervisor's only
// responsibilities are building the argv and handing back a pid +
// exited promise.
//
// Design choices:
// - Detach the child (`stdio: ignore` / dedicated log fd) so daemon
//   restart doesn't orphan-kill in-flight runs. Orphan recovery (phase
//   6) re-discovers them via the queue's `running` rows + pid-alive
//   check.
// - Pipe stdout/stderr to `<runsDir>/<runId>/worker.log`. Events
//   themselves go through `events.jsonl`; `worker.log` captures
//   stdout progress + any stack traces.
// - Pass `--run-id` so the child uses the daemon-assigned id. The
//   existing CLI already supports this flag, so the worker doesn't
//   need any new surface area.

import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { JobRow, ProcessSupervisor } from "../ports.ts";

export interface LocalProcessSupervisorOptions {
  /** Path to the interpreter (`Bun.argv[0]`, usually `bun`). */
  argv0: string;
  /** Path to the `swarm` entry script that argv0 will execute. */
  swarmScript: string;
  /** Project root; forwarded as `--cwd` and used as the child's cwd. */
  cwd: string;
  /** Runs directory; forwarded as `--runs-dir` and used to locate
   * each run's worker.log. */
  runsDir: string;
}

export function createLocalProcessSupervisor(opts: LocalProcessSupervisorOptions): ProcessSupervisor {
  const { argv0, swarmScript, cwd, runsDir } = opts;

  return {
    async spawn(job: JobRow) {
      const runDir = join(runsDir, job.runId);
      await mkdir(runDir, { recursive: true });
      const logFd = openSync(join(runDir, "worker.log"), "a");

      const args: string[] = [
        swarmScript,
        "run",
        job.workflow,
        "--run-id",
        job.runId,
        "--cwd",
        cwd,
        "--runs-dir",
        runsDir,
        // Interviewer=auto so the worker never tries to read stdin
        // (stdio is ignored below).
        "--interviewer",
        "auto",
      ];
      // Thread the client's worktree preference through to the worker.
      // Both branches are explicit so the worker doesn't silently pick
      // up a different default later.
      args.push(job.worktree ? "--worktree" : "--no-worktree");
      if (job.inputJson !== undefined) args.push("--input", job.inputJson);
      if (job.model !== undefined) args.push("--model", job.model);

      const child = Bun.spawn([argv0, ...args], {
        cwd,
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        // Opt the child OUT of the parent's process group so it
        // survives the daemon exiting. Orphan recovery adopts it
        // back on next startup.
        env: { ...process.env, SWARM_WORKER_JOB_ID: job.id, SWARM_WORKER_RUN_ID: job.runId },
      });
      // Don't let the child handle keep the daemon event loop alive
      // past its own scheduled stop.
      (child as { unref?: () => void }).unref?.();

      // `child.exited` is a Promise<number> resolving with the exit
      // code. Bun.spawn returns the pid synchronously on the handle.
      return { pid: child.pid, exited: child.exited };
    },

    async terminate(pid: number, signal = "SIGTERM"): Promise<boolean> {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, signal);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false; // already dead
        throw err;
      }
    },
  };
}

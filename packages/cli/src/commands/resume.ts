// `swarm resume <run-id>` — unblock a soft-paused pipeline.
//
// Writes a `ControlRequest { command: "resume" }` line to
// `<runsDir>/<run-id>/control.jsonl`. The executor wakes at the
// pause boundary and continues scheduling. Rejected with reason
// `not_paused` if the run isn't currently paused.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { submitControlRequest } from "@swarm/events";
import chalk from "chalk";

export interface ResumeCommandOptions {
  runId: string;
  runsDir?: string;
  cwd?: string;
}

export async function resumeCommand(opts: ResumeCommandOptions): Promise<number> {
  const runsDir = opts.runsDir ?? ".swarm/runs";
  const cwd = opts.cwd ?? process.cwd();
  const runDir = resolve(cwd, runsDir, opts.runId);

  try {
    const s = await stat(runDir);
    if (!s.isDirectory()) {
      console.error(chalk.red(`resume: ${runDir} is not a directory`));
      return 1;
    }
  } catch {
    console.error(
      chalk.red(
        `resume: run "${opts.runId}" not found at ${runDir}. ` +
          "Run `swarm list` to see recent run ids, or check the cwd.",
      ),
    );
    return 1;
  }

  const filePath = resolve(runDir, "control.jsonl");
  const request = await submitControlRequest(filePath, "resume");

  console.log(chalk.green(`resume → ${opts.runId}`));
  console.log(chalk.dim(`  file: ${filePath}`));
  console.log(chalk.dim(`  id:   ${request.id}`));
  return 0;
}
